import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAuth } from "../src/auth"
import { openDatabase } from "../src/database"
import { createSecurity, SkillMarketSecurityError } from "../src/security"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("SSO authentication", () => {
  test("consumes a TOKEN-mode login once and stores only identity and secret hashes", async () => {
    let provisionBody: unknown
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/provision/token")
        provisionBody = await request.json()
        return Response.json({ status: "ready", key: "sk-sensitive-gateway-key", tokenName: "GW00178937-武晓达" })
      },
    })
    const fixture = await authenticationFixture(server.url.origin)

    const login = fixture.auth.begin("/submissions")
    const authorization = new URL(login.authorizationUrl)
    expect(authorization.origin).toBe("https://sso.example.com")
    expect(authorization.searchParams.get("mode")).toBe("TOKEN")
    expect(authorization.searchParams.get("redirect_url")).toBe(
      `http://127.0.0.1:4210/v1/auth/callback/${login.attemptID}`,
    )
    expect(
      fixture.database.connection
        .query<{ attempt_hash: string; return_to: string }, []>("SELECT attempt_hash, return_to FROM login_attempts")
        .get(),
    ).toEqual({ attempt_hash: sha256(login.attemptID), return_to: "/submissions" })

    const result = await fixture.auth.complete(login.attemptID, "sso-sensitive-access-token")
    expect(provisionBody).toEqual({ ssoAccessToken: "sso-sensitive-access-token" })
    expect(result.returnTo).toBe("/submissions")
    expect(result.session.user).toEqual({ employeeID: "GW00178937", displayName: "武晓达" })
    expect(result.session.roles).toEqual([])
    expect(result.session.csrfToken).toBe(result.csrfToken)
    expect(result.sessionToken).toHaveLength(43)
    expect(result.csrfToken).toHaveLength(43)
    expect(result.setCookies).toEqual([
      `ruying_market_session=${result.sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
      `ruying_market_csrf=${result.csrfToken}; Path=/; SameSite=Lax; Max-Age=43200`,
    ])

    const stored = fixture.database.connection
      .query<{ session_hash: string; csrf_hash: string }, []>("SELECT session_hash, csrf_hash FROM sessions")
      .get()
    expect(stored).toEqual({ session_hash: sha256(result.sessionToken), csrf_hash: sha256(result.csrfToken) })
    const bytes = new TextDecoder().decode(fixture.database.connection.serialize())
    expect(bytes).not.toContain("sso-sensitive-access-token")
    expect(bytes).not.toContain("sk-sensitive-gateway-key")
    expect(bytes).not.toContain(result.sessionToken)
    expect(bytes).not.toContain(result.csrfToken)
    expect(JSON.stringify(result)).not.toContain("sk-sensitive-gateway-key")

    const logout = fixture.auth.logout(result.sessionToken)
    expect(logout.clearCookies).toEqual([
      "ruying_market_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      "ruying_market_csrf=; Path=/; SameSite=Lax; Max-Age=0",
    ])
    expect(
      fixture.database.connection.query<{ count: number }, []>("SELECT count(*) AS count FROM sessions").get()?.count,
    ).toBe(0)
    fixture.database.close()
  })

  test("allows only declared same-site return paths", async () => {
    using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) })
    const fixture = await authenticationFixture(server.url.origin)

    ;[
      "/skills",
      "/skills/community/my-skill",
      "/submissions",
      "/submissions/new",
      "/submissions/sub_abcdefgh",
      "/admin",
      "/admin/submissions/sub_abcdefgh",
      "/admin/roles",
      "/admin/audit",
    ].forEach((returnTo) => expect(() => fixture.auth.begin(returnTo)).not.toThrow())
    ;[
      "https://evil.example/submissions",
      "//evil.example/submissions",
      "/skills/unknown/my-skill",
      "/skills/community/my-skill?next=https://evil.example",
      "/skills/community/%2e%2e",
      "/admin/users",
      "/submissions/../../admin",
    ].forEach((returnTo) => expect(() => fixture.auth.begin(returnTo)).toThrow("returnTo is not allowed"))

    fixture.database.close()
  })

  test("rejects unknown, expired, and replayed attempts before provisioning", async () => {
    let calls = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        return Response.json({ status: "ready", key: "sk-key", tokenName: "E000001-Test User" })
      },
    })
    const fixture = await authenticationFixture(server.url.origin)

    expect((await securityFailure(fixture.auth.complete(`login_${"x".repeat(43)}`, "token"))).code).toBe(
      "unauthenticated",
    )
    const expired = fixture.auth.begin("/submissions")
    fixture.clock.value += 5 * 60 * 1_000
    expect((await securityFailure(fixture.auth.complete(expired.attemptID, "token"))).code).toBe("unauthenticated")
    expect(calls).toBe(0)

    const valid = fixture.auth.begin("/submissions")
    const complete = await fixture.auth.complete(valid.attemptID, "token")
    expect(complete.session.user.employeeID).toBe("E000001")
    expect((await securityFailure(fixture.auth.complete(valid.attemptID, "token"))).code).toBe("unauthenticated")
    expect(calls).toBe(1)

    fixture.database.close()
  })

  test("consumes attempts on provisioning rejection and refuses malformed trusted identity", async () => {
    let calls = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls++
        const body = await request.json()
        const token =
          typeof body === "object" && body !== null && "ssoAccessToken" in body ? body.ssoAccessToken : undefined
        if (token === "rejected") return new Response("invalid SSO", { status: 401 })
        if (token === "pending") return Response.json({ status: "pending_enable", tokenName: "E000001-Test User" })
        return Response.json({ status: "ready", key: "sk-key", tokenName: "missingdisplayname" })
      },
    })
    const fixture = await authenticationFixture(server.url.origin)

    const rejected = fixture.auth.begin("/submissions")
    expect((await securityFailure(fixture.auth.complete(rejected.attemptID, "rejected"))).code).toBe("unauthenticated")
    expect((await securityFailure(fixture.auth.complete(rejected.attemptID, "rejected"))).code).toBe("unauthenticated")
    expect(calls).toBe(1)

    const pending = fixture.auth.begin("/submissions")
    expect((await securityFailure(fixture.auth.complete(pending.attemptID, "pending"))).code).toBe("unauthenticated")
    const malformed = fixture.auth.begin("/submissions")
    expect((await securityFailure(fixture.auth.complete(malformed.attemptID, "malformed"))).code).toBe(
      "dependency-unavailable",
    )
    expect(
      fixture.database.connection.query<{ count: number }, []>("SELECT count(*) AS count FROM sessions").get()?.count,
    ).toBe(0)

    fixture.database.close()
  })

  test("does not create a session for a disabled trusted user", async () => {
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ status: "ready", key: "sk-key", tokenName: "E000001-Test User" }),
    })
    const fixture = await authenticationFixture(server.url.origin)
    fixture.database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at, disabled_at) VALUES (?, ?, ?, ?, ?)",
      ["E000001", "Disabled User", fixture.clock.value, fixture.clock.value, fixture.clock.value],
    )

    const login = fixture.auth.begin("/submissions")
    expect((await securityFailure(fixture.auth.complete(login.attemptID, "token"))).code).toBe("unauthenticated")
    expect(
      fixture.database.connection.query<{ count: number }, []>("SELECT count(*) AS count FROM sessions").get()?.count,
    ).toBe(0)

    fixture.database.close()
  })

  test("serializes production Secure cookies without weakening IP-test cookies", async () => {
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ status: "ready", key: "sk-key", tokenName: "E000001-Test User" }),
    })
    const fixture = await authenticationFixture(server.url.origin, true)
    const login = fixture.auth.begin("/admin")
    const result = await fixture.auth.complete(login.attemptID, "token")

    expect(result.setCookies).toEqual([
      `__Host-ruying_market_session=${result.sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
      `__Host-ruying_market_csrf=${result.csrfToken}; Path=/; Secure; SameSite=Lax; Max-Age=43200`,
    ])
    fixture.database.close()
  })
})

async function authenticationFixture(adminApiBaseUrl: string, cookieSecure = false) {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-auth-"))
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
  const auth = createAuth({
    database,
    security,
    ssoLoginUrl: "https://sso.example.com/login",
    adminApiBaseUrl,
    apiPublicUrl: "http://127.0.0.1:4210/",
    sessionCookieName: cookieSecure ? "__Host-ruying_market_session" : "ruying_market_session",
    cookieSecure,
    loginAttemptMilliseconds: 5 * 60 * 1_000,
    sessionAbsoluteMilliseconds: 12 * 60 * 60 * 1_000,
    now: () => clock.value,
  })
  return { auth, clock, database, security }
}

async function securityFailure(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected SkillMarketSecurityError")
    },
    (error) => {
      if (error instanceof SkillMarketSecurityError) return error
      throw error
    },
  )
}

function sha256(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}
