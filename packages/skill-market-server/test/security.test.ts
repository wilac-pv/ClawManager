import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { bootstrapAdmins, createSecurity } from "../src/security"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("market security", () => {
  test("loads roles from SQLite and enforces the submitter, reviewer, and admin matrix", async () => {
    const fixture = await securityFixture()
    seedUser(fixture, "submitter", [])
    seedUser(fixture, "reviewer", ["reviewer"])
    seedUser(fixture, "admin", ["admin"])

    const submitter = fixture.security.requireSession(credentials("submitter"))
    expect(submitter.session.roles).toEqual([])
    expect(fixture.security.requireOwner(submitter, "submitter")).toBe(submitter)
    expect(() => fixture.security.requireOwner(submitter, "admin")).toThrow("another employee")
    expect(() => fixture.security.requireReviewer(submitter)).toThrow("reviewer role")
    const forged = { ...submitter, claimedEmployeeID: "admin" }
    expect(() => fixture.security.requireAdmin(forged)).toThrow("admin role")

    const reviewer = fixture.security.requireSession(credentials("reviewer"))
    expect(fixture.security.requireReviewer(reviewer)).toBe(reviewer)
    expect(fixture.security.requireReviewTarget(reviewer, "submitter")).toBe(reviewer)
    expect(() => fixture.security.requireReviewTarget(reviewer, "reviewer")).toThrow("own submission")
    expect(() => fixture.security.requireAdmin(reviewer)).toThrow("admin role")

    const admin = fixture.security.requireSession(credentials("admin"))
    expect(fixture.security.requireReviewer(admin)).toBe(admin)
    expect(fixture.security.requireAdmin(admin)).toBe(admin)

    fixture.database.close()
  })

  test("rejects disabled and expired sessions and refreshes activity at most every five minutes", async () => {
    const fixture = await securityFixture()
    seedUser(fixture, "active", [])
    seedUser(fixture, "disabled", [], fixture.clock.value)

    expect(() => fixture.security.requireSession(credentials("disabled"))).toThrow("session is not active")
    expect(sessionCount(fixture, "disabled")).toBe(0)

    fixture.clock.value += 4 * 60 * 1_000
    fixture.security.requireSession(credentials("active"))
    expect(lastActivity(fixture, "active")).toBe(Date.parse("2026-07-15T00:00:00.000Z"))
    fixture.clock.value += 60 * 1_000
    fixture.security.requireSession(credentials("active"))
    expect(lastActivity(fixture, "active")).toBe(fixture.clock.value)

    fixture.database.connection.run("UPDATE sessions SET last_activity_at = ? WHERE session_hash = ?", [
      Date.parse("2026-07-15T00:00:00.000Z"),
      sha256(credentials("active").sessionToken),
    ])
    fixture.clock.value = Date.parse("2026-07-15T02:00:00.000Z")
    expect(() => fixture.security.requireSession(credentials("active"))).toThrow("session is not active")
    expect(sessionCount(fixture, "active")).toBe(0)

    seedUser(fixture, "absolute", [], undefined, Date.parse("2026-07-15T11:59:00.000Z"))
    fixture.clock.value = Date.parse("2026-07-15T12:00:00.000Z")
    expect(() => fixture.security.requireSession(credentials("absolute"))).toThrow("session is not active")
    expect(sessionCount(fixture, "absolute")).toBe(0)

    fixture.database.close()
  })

  test("requires the exact Origin and constant-time CSRF hash for writes", async () => {
    const fixture = await securityFixture()
    seedUser(fixture, "submitter", [])
    const principal = fixture.security.requireSession(credentials("submitter"))

    expect(
      fixture.security.requireWriteProtection(principal, {
        origin: "http://127.0.0.1:4211",
        csrfToken: credentials("submitter").csrfToken,
      }),
    ).toBe(principal)
    expect(() =>
      fixture.security.requireWriteProtection(principal, {
        origin: "http://evil.example",
        csrfToken: credentials("submitter").csrfToken,
      }),
    ).toThrow("Origin")
    expect(() =>
      fixture.security.requireWriteProtection(principal, {
        origin: "http://127.0.0.1:4211",
        csrfToken: "x".repeat(43),
      }),
    ).toThrow("CSRF")

    fixture.database.close()
  })

  test("bootstraps configured admins once with append-only audit events", async () => {
    const fixture = await securityFixture()

    expect(bootstrapAdmins(fixture.database, ["E000001", "E000002"], fixture.clock.value)).toBe(2)
    expect(
      fixture.database.connection
        .query<
          { employee_id: string; created_by: string },
          []
        >("SELECT employee_id, created_by FROM role_assignments WHERE role = 'admin' ORDER BY employee_id")
        .all(),
    ).toEqual([
      { employee_id: "E000001", created_by: "E000001" },
      { employee_id: "E000002", created_by: "E000002" },
    ])
    expect(
      fixture.database.connection
        .query<
          { action: string; object_id: string },
          []
        >("SELECT action, object_id FROM audit_events ORDER BY object_id")
        .all(),
    ).toEqual([
      { action: "bootstrap-admin", object_id: "E000001" },
      { action: "bootstrap-admin", object_id: "E000002" },
    ])
    expect(bootstrapAdmins(fixture.database, ["E000003"], fixture.clock.value)).toBe(0)
    expect(
      fixture.database.connection
        .query<{ count: number }, []>("SELECT count(*) AS count FROM users WHERE employee_id = 'E000003'")
        .get()?.count,
    ).toBe(0)

    seedSession(fixture, "E000001")
    const admin = fixture.security.requireSession(credentials("E000001"))
    expect(fixture.security.requireRoleRemoval(admin, "E000001", "admin")).toBe(admin)
    fixture.database.connection.run("DELETE FROM role_assignments WHERE employee_id = 'E000002' AND role = 'admin'")
    expect(() => fixture.security.requireRoleRemoval(admin, "E000001", "admin")).toThrow("last admin")
    expect(fixture.security.requireRoleRemoval(admin, "E000001", "reviewer")).toBe(admin)

    fixture.database.close()
  })
})

async function securityFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-security-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const clock = { value: Date.parse("2026-07-15T00:00:00.000Z") }
  const security = createSecurity({
    database,
    webOrigin: "http://127.0.0.1:4211",
    sessionIdleMilliseconds: 2 * 60 * 60 * 1_000,
    sessionAbsoluteMilliseconds: 12 * 60 * 60 * 1_000,
    now: () => clock.value,
  })
  return { clock, database, security }
}

function seedUser(
  fixture: Awaited<ReturnType<typeof securityFixture>>,
  employeeID: string,
  roles: ReadonlyArray<"reviewer" | "admin">,
  disabledAt?: number,
  lastActivityAt = fixture.clock.value,
) {
  fixture.database.transaction((connection) => {
    connection.run(
      "INSERT OR REPLACE INTO users (employee_id, display_name, created_at, last_login_at, disabled_at) VALUES (?, ?, ?, ?, ?)",
      [employeeID, employeeID, Date.parse("2026-07-15T00:00:00.000Z"), fixture.clock.value, disabledAt ?? null],
    )
    roles.forEach((role) =>
      connection.run("INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, ?, ?, ?)", [
        employeeID,
        role,
        employeeID,
        fixture.clock.value,
      ]),
    )
    seedSession(fixture, employeeID, lastActivityAt, connection)
  })
}

function seedSession(
  fixture: Awaited<ReturnType<typeof securityFixture>>,
  employeeID: string,
  lastActivityAt = fixture.clock.value,
  connection = fixture.database.connection,
) {
  connection.run(
    "INSERT INTO sessions (session_hash, employee_id, csrf_hash, created_at, last_activity_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      sha256(credentials(employeeID).sessionToken),
      employeeID,
      sha256(credentials(employeeID).csrfToken),
      Date.parse("2026-07-15T00:00:00.000Z"),
      lastActivityAt,
      Date.parse("2026-07-15T12:00:00.000Z"),
    ],
  )
}

function credentials(employeeID: string) {
  return {
    sessionToken: token(employeeID, "session"),
    csrfToken: token(employeeID, "csrf"),
  }
}

function token(employeeID: string, purpose: string) {
  return new Bun.CryptoHasher("sha256").update(`${employeeID}:${purpose}`).digest("base64url")
}

function sha256(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function sessionCount(fixture: Awaited<ReturnType<typeof securityFixture>>, employeeID: string) {
  return fixture.database.connection
    .query<{ count: number }, [string]>("SELECT count(*) AS count FROM sessions WHERE employee_id = ?")
    .get(employeeID)!.count
}

function lastActivity(fixture: Awaited<ReturnType<typeof securityFixture>>, employeeID: string) {
  return fixture.database.connection
    .query<{ last_activity_at: number }, [string]>("SELECT last_activity_at FROM sessions WHERE employee_id = ?")
    .get(employeeID)!.last_activity_at
}
