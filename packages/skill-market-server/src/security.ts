import { timingSafeEqual } from "node:crypto"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MarketDatabase } from "./database"

interface SecurityOptions {
  readonly database: MarketDatabase
  readonly webOrigin: string
  readonly sessionIdleMilliseconds: number
  readonly sessionAbsoluteMilliseconds: number
  readonly activityRefreshMilliseconds?: number
  readonly now?: () => number
}

interface SessionCredentials {
  readonly sessionToken: string
  readonly csrfToken: string
}

interface WriteCredentials {
  readonly origin: string | undefined
  readonly csrfToken: string | undefined
}

interface SessionRow {
  readonly session_hash: string
  readonly csrf_hash: string
  readonly employee_id: string
  readonly display_name: string
  readonly email: string | null
  readonly disabled_at: number | null
  readonly created_at: number
  readonly last_activity_at: number
  readonly absolute_expires_at: number
}

export interface Principal {
  readonly session: SkillMarketControl.Session
  readonly csrfHash: string
}

export class SkillMarketSecurityError extends Error {
  constructor(
    readonly code: SkillMarketControl.ProblemCode,
    message: string,
  ) {
    super(message)
    this.name = "SkillMarketSecurityError"
  }
}

export class MarketSecurity {
  constructor(private readonly options: SecurityOptions) {}

  requireSession(credentials: SessionCredentials) {
    const now = this.options.now?.() ?? Date.now()
    const state = this.options.database.transaction((connection) => {
      const row = connection
        .query<SessionRow, [string]>(
          `SELECT
            sessions.session_hash,
            sessions.csrf_hash,
            sessions.employee_id,
            users.display_name,
            users.email,
            users.disabled_at,
            sessions.created_at,
            sessions.last_activity_at,
            sessions.absolute_expires_at
          FROM sessions
          INNER JOIN users ON users.employee_id = sessions.employee_id
          WHERE sessions.session_hash = ?`,
        )
        .get(hashSecret(credentials.sessionToken))
      if (!row) return { kind: "inactive" } as const
      if (
        row.disabled_at !== null ||
        now >= row.absolute_expires_at ||
        now - row.last_activity_at >= this.options.sessionIdleMilliseconds
      ) {
        connection.run("DELETE FROM sessions WHERE session_hash = ?", [row.session_hash])
        return { kind: "inactive" } as const
      }
      if (!safeSecretMatches(credentials.csrfToken, row.csrf_hash)) return { kind: "inactive" } as const

      const lastActivityAt =
        now - row.last_activity_at >= (this.options.activityRefreshMilliseconds ?? 5 * 60 * 1_000)
          ? now
          : row.last_activity_at
      if (lastActivityAt !== row.last_activity_at)
        connection.run("UPDATE sessions SET last_activity_at = ? WHERE session_hash = ?", [
          lastActivityAt,
          row.session_hash,
        ])
      const roles = connection
        .query<{ role: SkillMarketControl.Role }, [string]>(
          "SELECT role FROM role_assignments WHERE employee_id = ? ORDER BY role",
        )
        .all(row.employee_id)
        .map((entry) => entry.role)
      const user = {
        employeeID: row.employee_id,
        displayName: row.display_name,
        ...(row.email ? { email: row.email } : {}),
      } satisfies SkillMarketControl.User
      return {
        kind: "active",
        principal: {
          session: {
            user,
            roles,
            csrfToken: credentials.csrfToken,
            createdAt: new Date(row.created_at).toISOString(),
            absoluteExpiresAt: new Date(row.absolute_expires_at).toISOString(),
            idleExpiresAt: new Date(
              Math.min(row.absolute_expires_at, lastActivityAt + this.options.sessionIdleMilliseconds),
            ).toISOString(),
          },
          csrfHash: row.csrf_hash,
        } satisfies Principal,
      } as const
    })
    if (state.kind === "active") return state.principal
    throw new SkillMarketSecurityError("unauthenticated", "session is not active")
  }

  requireOwner(principal: Principal, ownerEmployeeID: string) {
    if (principal.session.user.employeeID === ownerEmployeeID) return principal
    throw new SkillMarketSecurityError("forbidden", "resource belongs to another employee")
  }

  requireReviewer(principal: Principal) {
    if (principal.session.roles.includes("reviewer") || principal.session.roles.includes("admin")) return principal
    throw new SkillMarketSecurityError("forbidden", "reviewer role is required")
  }

  requireReviewTarget(principal: Principal, ownerEmployeeID: string) {
    this.requireReviewer(principal)
    if (principal.session.roles.includes("admin")) return principal
    if (principal.session.user.employeeID !== ownerEmployeeID) return principal
    throw new SkillMarketSecurityError("forbidden", "reviewers cannot review their own submission")
  }

  requireAdmin(principal: Principal) {
    if (principal.session.roles.includes("admin")) return principal
    throw new SkillMarketSecurityError("forbidden", "admin role is required")
  }

  requireWriteProtection(principal: Principal, credentials: WriteCredentials) {
    if (credentials.origin !== this.options.webOrigin)
      throw new SkillMarketSecurityError("forbidden", "request Origin is not allowed")
    if (!credentials.csrfToken || !safeSecretMatches(credentials.csrfToken, principal.csrfHash))
      throw new SkillMarketSecurityError("csrf-invalid", "CSRF token is invalid")
    return principal
  }

  requireRoleRemoval(principal: Principal, employeeID: string, role: SkillMarketControl.Role) {
    this.requireAdmin(principal)
    if (role !== "admin") return principal
    const admins = this.options.database.connection
      .query<{ count: number }, []>("SELECT count(*) AS count FROM role_assignments WHERE role = 'admin'")
      .get()!.count
    if (admins > 1) return principal
    const targetIsAdmin = this.options.database.connection
      .query<
        { count: number },
        [string]
      >("SELECT count(*) AS count FROM role_assignments WHERE employee_id = ? AND role = 'admin'")
      .get(employeeID)!.count
    if (targetIsAdmin === 0) return principal
    throw new SkillMarketSecurityError("last-admin", "the last admin cannot be removed")
  }
}

export function createSecurity(options: SecurityOptions) {
  return new MarketSecurity(options)
}

export function bootstrapAdmins(database: MarketDatabase, employeeIDs: ReadonlyArray<string>, now = Date.now()) {
  return database.transaction((connection) => {
    const admins = connection
      .query<{ count: number }, []>("SELECT count(*) AS count FROM role_assignments WHERE role = 'admin'")
      .get()!.count
    if (admins > 0) return 0
    const unique = [...new Set(employeeIDs)]
    unique.forEach((employeeID) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(employeeID))
        throw new SkillMarketSecurityError("invalid-request", "bootstrap admin employee ID is invalid")
      connection.run(
        `INSERT INTO users (employee_id, display_name, created_at, last_login_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(employee_id) DO NOTHING`,
        [employeeID, employeeID, now, now],
      )
      connection.run(
        "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, 'admin', ?, ?)",
        [employeeID, employeeID, now],
      )
      connection.run(
        `INSERT INTO audit_events
          (id, action, object_type, object_id, after_json, request_id, created_at)
         VALUES (?, 'bootstrap-admin', 'role', ?, ?, ?, ?)`,
        [`aud_${randomSecret()}`, employeeID, JSON.stringify({ role: "admin" }), `req_${randomSecret()}`, now],
      )
    })
    return unique.length
  })
}

export function randomSecret() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytes.toBase64({ alphabet: "base64url", omitPadding: true })
}

export function hashSecret(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function safeSecretMatches(value: string, expectedHash: string) {
  const actual = new TextEncoder().encode(hashSecret(value))
  const expected = new TextEncoder().encode(expectedHash)
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}
