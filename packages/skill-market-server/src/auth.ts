import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MarketDatabase } from "./database"
import type { MarketMetricEmitter } from "./metrics"
import { hashSecret, MarketSecurity, randomSecret, SkillMarketSecurityError } from "./security"

interface AuthOptions {
  readonly database: MarketDatabase
  readonly security: MarketSecurity
  readonly ssoLoginUrl: string
  readonly adminApiBaseUrl: string
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

interface ProvisioningIdentity {
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

      const identity = await provisionIdentity(options, token)
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
             department_id = excluded.department_id,
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

async function provisionIdentity(options: AuthOptions, token: string) {
  const response = await (options.fetch ?? fetch)(new URL("/api/provision/token", options.adminApiBaseUrl), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ ssoAccessToken: token }),
  }).then(
    (value) => value,
    () => {
      throw provisioningFailure(options, "network", "dependency-unavailable", "provisioning service is unavailable")
    },
  )
  if (response.status === 401 || response.status === 403)
    throw provisioningFailure(options, "rejected", "unauthenticated", "SSO token was rejected", response.status)
  if (!response.ok)
    throw provisioningFailure(
      options,
      "http",
      "dependency-unavailable",
      "provisioning service is unavailable",
      response.status,
    )

  const body = await response.json().then(
    (value) => value,
    () => undefined,
  )
  if (!record(body))
    throw provisioningFailure(options, "json", "dependency-unavailable", "provisioning response is malformed")
  if (body.status === "pending_enable")
    throw provisioningFailure(options, "pending", "unauthenticated", "account provisioning is pending")
  if (body.status !== "ready" || typeof body.key !== "string" || !body.key || typeof body.tokenName !== "string")
    throw provisioningFailure(options, "response", "dependency-unavailable", "provisioning response is malformed")
  return parseIdentity(options, body.tokenName, body.departmentId, body.departmentName)
}

function parseIdentity(
  options: AuthOptions,
  tokenName: string,
  departmentID: unknown,
  departmentName: unknown,
): ProvisioningIdentity {
  const name = tokenName.trim()
  const separator = name.indexOf("-")
  const employeeID = separator > 0 ? name.slice(0, separator) : ""
  const displayName = separator > 0 ? name.slice(separator + 1).trim() : ""
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(employeeID) || displayName.length < 1 || displayName.length > 100)
    throw provisioningFailure(options, "identity", "dependency-unavailable", "provisioning identity is malformed")
  if (
    (departmentID === undefined && departmentName === undefined) ||
    (departmentID === null && departmentName === null) ||
    (typeof departmentID === "string" &&
      typeof departmentName === "string" &&
      !departmentID.trim() &&
      !departmentName.trim())
  )
    return { employeeID, displayName }
  const normalizedDepartmentID =
    typeof departmentID === "string"
      ? departmentID.trim()
      : typeof departmentID === "number" && Number.isSafeInteger(departmentID) && departmentID >= 0
        ? String(departmentID)
        : undefined
  if (normalizedDepartmentID === undefined)
    throw provisioningFailure(
      options,
      "department-id-type",
      "dependency-unavailable",
      "provisioning department is malformed",
    )
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(normalizedDepartmentID))
    throw provisioningFailure(
      options,
      "department-id-format",
      "dependency-unavailable",
      "provisioning department is malformed",
    )
  if (typeof departmentName !== "string")
    throw provisioningFailure(
      options,
      "department-name-type",
      "dependency-unavailable",
      "provisioning department is malformed",
    )
  if (departmentName.trim().length < 1 || departmentName.trim().length > 100)
    throw provisioningFailure(
      options,
      "department-name-length",
      "dependency-unavailable",
      "provisioning department is malformed",
    )
  return { employeeID, displayName, department: { id: normalizedDepartmentID, name: departmentName.trim() } }
}

function provisioningFailure(
  options: AuthOptions,
  stage:
    | "network"
    | "rejected"
    | "http"
    | "json"
    | "pending"
    | "response"
    | "identity"
    | "department-id-type"
    | "department-id-format"
    | "department-name-type"
    | "department-name-length",
  code: "unauthenticated" | "dependency-unavailable",
  message: string,
  status?: number,
) {
  options.emit?.({
    skill_market_provisioning_failure: {
      [stage]: 1,
      ...(status === undefined ? {} : { [`http_${status}`]: 1 }),
    },
  })
  return new SkillMarketSecurityError(code, message)
}

function allowedReturnTo(value: string) {
  return (
    value === "/skills" ||
    /^\/skills\/(skillhub|enterprise|community)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) ||
    value === "/submissions" ||
    value === "/submissions/new" ||
    /^\/submissions\/sub_[a-zA-Z0-9_-]{8,64}$/.test(value) ||
    value === "/admin" ||
    /^\/admin\/submissions\/sub_[a-zA-Z0-9_-]{8,64}$/.test(value) ||
    value === "/admin/roles" ||
    value === "/admin/audit" ||
    value === "/admin/skillhub"
  )
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
