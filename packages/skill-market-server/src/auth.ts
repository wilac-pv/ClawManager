import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MarketDatabase } from "./database"
import type { MarketMetricEmitter } from "./metrics"
import { hashSecret, MarketSecurity, randomSecret, SkillMarketSecurityError } from "./security"

interface AuthOptions {
  readonly database: MarketDatabase
  readonly security: MarketSecurity
  readonly ssoLoginUrl: string
  readonly ssoCheckTokenUrl: string
  readonly ssoPlatformCode: string
  readonly departmentLookupUrl: string
  readonly departmentLookupAppCode: string
  readonly apiPublicUrl: string
  readonly sessionCookieName: string
  readonly cookieSecure: boolean
  readonly loginAttemptMilliseconds: number
  readonly sessionAbsoluteMilliseconds: number
  readonly now?: () => number
  readonly fetch?: typeof fetch
  readonly emit?: MarketMetricEmitter
}

interface AttemptRow {
  readonly return_to: string
  readonly expires_at: number
  readonly consumed_at: number | null
}

interface UserRow {
  readonly disabled_at: number | null
}

interface SsoIdentity {
  readonly employeeID: string
  readonly displayName: string
  readonly department?: SkillMarketControl.Department
}

export function createAuth(options: AuthOptions) {
  const csrfCookieName = options.sessionCookieName.replace(/session$/, "csrf")
  const sessionCookieMaxAgeSeconds = Math.floor(options.sessionAbsoluteMilliseconds / 1_000)

  return {
    begin(returnTo: string) {
      if (!allowedReturnTo(returnTo)) throw new SkillMarketSecurityError("invalid-request", "returnTo is not allowed")
      const attemptID = `login_${randomSecret()}`
      const now = options.now?.() ?? Date.now()
      options.database.transaction((connection) =>
        connection.run(
          "INSERT INTO login_attempts (attempt_hash, return_to, created_at, expires_at) VALUES (?, ?, ?, ?)",
          [hashSecret(attemptID), returnTo, now, now + options.loginAttemptMilliseconds],
        ),
      )
      const callback = new URL(`/v1/auth/callback/${attemptID}`, options.apiPublicUrl)
      const authorization = new URL(options.ssoLoginUrl)
      authorization.searchParams.set("mode", "TOKEN")
      authorization.searchParams.set("logout", "1")
      authorization.searchParams.set("redirect_url", callback.href)
      return { attemptID, authorizationUrl: authorization.href }
    },

    async complete(attemptID: string, token: string) {
      const now = options.now?.() ?? Date.now()
      const returnTo = options.database.transaction((connection) => {
        const attempt = connection
          .query<
            AttemptRow,
            [string]
          >("SELECT return_to, expires_at, consumed_at FROM login_attempts WHERE attempt_hash = ?")
          .get(hashSecret(attemptID))
        if (!attempt || attempt.consumed_at !== null || now >= attempt.expires_at) return undefined
        const consumed = connection.run(
          "UPDATE login_attempts SET consumed_at = ? WHERE attempt_hash = ? AND consumed_at IS NULL",
          [now, hashSecret(attemptID)],
        )
        if (consumed.changes !== 1) return undefined
        return attempt.return_to
      })
      if (!returnTo) throw new SkillMarketSecurityError("unauthenticated", "login attempt is not active")

      const identity = await verifyIdentity(options, token)
      const sessionToken = randomSecret()
      const csrfToken = randomSecret()
      const created = options.database.transaction((connection) => {
        const user = connection
          .query<UserRow, [string]>("SELECT disabled_at FROM users WHERE employee_id = ?")
          .get(identity.employeeID)
        if (user?.disabled_at !== null && user?.disabled_at !== undefined) return false
        if (identity.department)
          connection.run(
            `INSERT INTO departments (department_id, display_name, first_seen_at, last_seen_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(department_id) DO UPDATE SET
               display_name = excluded.display_name,
               last_seen_at = excluded.last_seen_at`,
            [identity.department.id, identity.department.name, now, now],
          )
        connection.run(
          `INSERT INTO users (employee_id, display_name, department_id, created_at, last_login_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(employee_id) DO UPDATE SET
             display_name = excluded.display_name,
             department_id = COALESCE(excluded.department_id, users.department_id),
             last_login_at = excluded.last_login_at`,
          [identity.employeeID, identity.displayName, identity.department?.id ?? null, now, now],
        )
        connection.run(
          `INSERT INTO sessions
            (session_hash, employee_id, csrf_hash, created_at, last_activity_at, absolute_expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            hashSecret(sessionToken),
            identity.employeeID,
            hashSecret(csrfToken),
            now,
            now,
            now + options.sessionAbsoluteMilliseconds,
          ],
        )
        return true
      })
      if (!created) throw new SkillMarketSecurityError("unauthenticated", "disabled users cannot create a session")

      return {
        returnTo,
        sessionToken,
        csrfToken,
        session: options.security.requireSession({ sessionToken, csrfToken }).session,
        setCookies: [
          cookie(options.sessionCookieName, sessionToken, true, options.cookieSecure, sessionCookieMaxAgeSeconds),
          cookie(csrfCookieName, csrfToken, false, options.cookieSecure, sessionCookieMaxAgeSeconds),
        ],
      }
    },

    session(sessionToken: string, csrfToken: string) {
      return options.security.requireSession({ sessionToken, csrfToken }).session
    },

    logout(sessionToken: string) {
      options.database.transaction((connection) =>
        connection.run("DELETE FROM sessions WHERE session_hash = ?", [hashSecret(sessionToken)]),
      )
      return {
        clearCookies: [
          cookie(options.sessionCookieName, "", true, options.cookieSecure, 0),
          cookie(csrfCookieName, "", false, options.cookieSecure, 0),
        ],
      }
    },
  }
}

async function verifyIdentity(options: AuthOptions, token: string) {
  const checkUrl = new URL(options.ssoCheckTokenUrl)
  checkUrl.searchParams.set("access_token", token)
  checkUrl.searchParams.set("platform_code", options.ssoPlatformCode)
  const response = await (options.fetch ?? fetch)(checkUrl, {
    method: "GET",
    headers: { accept: "application/json" },
  }).then(
    (value) => value,
    () => {
      throw identityFailure(options, "sso-network", "dependency-unavailable", "SSO validation service is unavailable")
    },
  )
  if (response.status === 401 || response.status === 403)
    throw identityFailure(options, "sso-rejected", "unauthenticated", "SSO token was rejected", response.status)
  if (!response.ok)
    throw identityFailure(
      options,
      "sso-http",
      "dependency-unavailable",
      "SSO validation service is unavailable",
      response.status,
    )

  const body = await response.json().then(
    (value) => value,
    () => undefined,
  )
  if (!record(body))
    throw identityFailure(options, "sso-json", "dependency-unavailable", "SSO validation response is malformed")
  if (body.key !== "S_0000")
    throw identityFailure(options, "sso-rejected", "unauthenticated", "SSO token was rejected")
  if (!record(body.result))
    throw identityFailure(options, "sso-response", "dependency-unavailable", "SSO validation response is malformed")
  const employeeID = typeof body.result.user_code === "string" ? body.result.user_code.trim() : ""
  const displayName = typeof body.result.user_name === "string" ? body.result.user_name.trim() : ""
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(employeeID) || displayName.length < 1 || displayName.length > 100)
    throw identityFailure(options, "sso-identity", "dependency-unavailable", "SSO identity is malformed")
  return {
    employeeID,
    displayName,
    department: await loadDepartment(options, employeeID),
  }
}

async function loadDepartment(options: AuthOptions, employeeID: string) {
  const lookupUrl = new URL(options.departmentLookupUrl)
  lookupUrl.searchParams.set("appCode", options.departmentLookupAppCode)
  lookupUrl.searchParams.set("person_number", employeeID.toUpperCase())
  const response = await (options.fetch ?? fetch)(lookupUrl, {
    method: "GET",
    headers: { accept: "application/json" },
  }).then(
    (value) => value,
    () => {
      throw identityFailure(options, "department-network", "dependency-unavailable", "department service is unavailable")
    },
  )
  if (!response.ok)
    throw identityFailure(
      options,
      "department-http",
      "dependency-unavailable",
      "department service is unavailable",
      response.status,
    )
  const body = await response.json().then(
    (value) => value,
    () => undefined,
  )
  if (!record(body) || body.errCode !== 0 || !Array.isArray(body.data))
    throw identityFailure(
      options,
      "department-response",
      "dependency-unavailable",
      "department response is malformed",
    )
  if (body.data.length === 0) return undefined
  const department = body.data[0]
  if (!record(department))
    throw identityFailure(
      options,
      "department-response",
      "dependency-unavailable",
      "department response is malformed",
    )
  const normalizedDepartmentID =
    typeof department.team_id === "string"
      ? department.team_id.trim()
      : typeof department.team_id === "number" && Number.isSafeInteger(department.team_id) && department.team_id >= 0
        ? String(department.team_id)
        : undefined
  if (normalizedDepartmentID === undefined)
    throw identityFailure(
      options,
      "department-id",
      "dependency-unavailable",
      "department response is malformed",
    )
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(normalizedDepartmentID))
    throw identityFailure(
      options,
      "department-id",
      "dependency-unavailable",
      "department response is malformed",
    )
  if (typeof department.team_name !== "string")
    throw identityFailure(
      options,
      "department-name",
      "dependency-unavailable",
      "department response is malformed",
    )
  if (department.team_name.trim().length < 1 || department.team_name.trim().length > 100)
    throw identityFailure(
      options,
      "department-name",
      "dependency-unavailable",
      "department response is malformed",
    )
  return { id: normalizedDepartmentID, name: department.team_name.trim() }
}

function identityFailure(
  options: AuthOptions,
  stage:
    | "sso-network"
    | "sso-rejected"
    | "sso-http"
    | "sso-json"
    | "sso-response"
    | "sso-identity"
    | "department-network"
    | "department-http"
    | "department-response"
    | "department-id"
    | "department-name",
  code: "unauthenticated" | "dependency-unavailable",
  message: string,
  status?: number,
) {
  options.emit?.({
    skill_market_sso_identity_failure: {
      [stage]: 1,
      ...(status === undefined ? {} : { [`http_${status}`]: 1 }),
    },
  })
  return new SkillMarketSecurityError(code, message)
}

function allowedReturnTo(value: string) {
  if (value.length > 2_048 || value !== value.trim() || value.startsWith("//")) return false
  const base = "https://market.invalid"
  if (!URL.canParse(value, base)) return false
  const url = new URL(value, base)
  if (url.origin !== base || url.hash) return false
  const query = value.indexOf("?")
  const pathname = value.slice(0, query < 0 ? value.length : query)
  const allowed =
    pathname === "/skills" ||
    /^\/skills\/(skillhub|enterprise|community)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(pathname) ||
    pathname === "/announcements" ||
    /^\/announcements\/ann_[a-zA-Z0-9_-]{8,64}$/.test(pathname) ||
    pathname === "/expert-packages" ||
    /^\/expert-packages\/[a-z0-9][a-z0-9-]{0,127}$/.test(pathname) ||
    pathname === "/favorites" ||
    pathname === "/submissions" ||
    pathname === "/personal" ||
    pathname === "/submissions/new" ||
    /^\/submissions\/sub_[a-zA-Z0-9_-]{8,64}$/.test(pathname) ||
    pathname === "/admin" ||
    /^\/admin\/submissions\/sub_[a-zA-Z0-9_-]{8,64}$/.test(pathname) ||
    pathname === "/admin/roles" ||
    pathname === "/admin/audit" ||
    pathname === "/admin/skillhub" ||
    pathname === "/admin/announcements"
  if (!allowed) return false
  return allowedReturnToQuery(pathname, url.searchParams)
}

function allowedReturnToQuery(pathname: string, search: URLSearchParams) {
  const allowed =
    pathname === "/submissions" || pathname === "/personal"
      ? new Set(["status", "page"])
      : pathname === "/submissions/new"
        ? new Set(["target", "from"])
        : /^\/submissions\/sub_/.test(pathname)
          ? new Set(["revise", "tab"])
          : pathname === "/admin"
            ? new Set(["status", "risk", "submitter", "createdFrom", "createdTo", "page"])
            : pathname === "/admin/audit"
              ? new Set(["actor", "action", "objectType", "objectID", "createdFrom", "createdTo", "page"])
              : new Set<string>()
  const entries = Array.from(search)
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return false
  return entries.every(([key, value]) => {
    if (!allowed.has(key) || value.length > 128) return false
    if (key === "page") return /^[1-9][0-9]{0,8}$/.test(value)
    if (key === "target") return value === "personal" || value === "company"
    if (key === "from") return /^sub_[a-zA-Z0-9_-]{8,64}$/.test(value)
    if (key === "revise") return value === "1"
    return value.length > 0
  })
}

function cookie(name: string, value: string, httpOnly: boolean, secure: boolean, maxAge: number) {
  return [
    `${name}=${value}`,
    "Path=/",
    ...(httpOnly ? ["HttpOnly"] : []),
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
