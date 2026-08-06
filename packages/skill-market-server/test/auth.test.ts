import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAuth } from "../src/auth"
import { openDatabase, SqliteDatabase } from "../src/database"
import { createModeration } from "../src/moderation"
import { bootstrapAdmins, type Principal, createSecurity, SkillMarketSecurityError } from "../src/security"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("SSO authentication", () => {
  test("validates SSO directly and loads the user's department without provisioning", async () => {
    const requests: URL[] = []
    const fixture = await authenticationFixture("https://unused.example.com", false, {
      ssoCheckTokenUrl: "http://auth.example.com/authenticate/check_token",
      ssoPlatformCode: "platform-test",
      departmentLookupUrl: "http://pcm.example.com/team",
      departmentLookupAppCode: "department-test",
      fetch: Object.assign(
        async (request: string | URL | Request) => {
          const url = new URL(request instanceof Request ? request.url : request)
          requests.push(url)
          if (url.pathname === "/authenticate/check_token")
            return Response.json({
              key: "S_0000",
              result: { user_code: "GW00178937", user_name: "武晓达", email: "user@gwm.cn" },
            })
          if (url.pathname === "/team")
            return Response.json({
              data: [{ person_number: "GW00178937", team_id: 100200300, team_name: "研发一部" }],
              errCode: 0,
              errMsg: "success",
            })
          return new Response(null, { status: 404 })
        },
        { preconnect: fetch.preconnect },
      ),
    })

    const result = await fixture.auth.complete((await fixture.auth.begin("/skills")).attemptID, "sso-sensitive-access-token")

    expect(
      requests.map((url) => ({
        pathname: url.pathname,
        accessToken: url.searchParams.get("access_token"),
        platformCode: url.searchParams.get("platform_code"),
        appCode: url.searchParams.get("appCode"),
        employeeID: url.searchParams.get("person_number"),
      })),
    ).toEqual([
      {
        pathname: "/authenticate/check_token",
        accessToken: "sso-sensitive-access-token",
        platformCode: "platform-test",
        appCode: null,
        employeeID: null,
      },
      {
        pathname: "/team",
        accessToken: null,
        platformCode: null,
        appCode: "department-test",
        employeeID: "GW00178937",
      },
    ])
    expect(result.session.user).toEqual({
      employeeID: "GW00178937",
      displayName: "武晓达",
      department: { id: "100200300", name: "研发一部" },
    })
    await fixture.database.close()
  })

  test("consumes a TOKEN-mode login once and stores only identity and secret hashes", async () => {
    const identityRequests: URL[] = []
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        identityRequests.push(url)
        if (url.pathname === "/authenticate/check_token")
          return Response.json({
            key: "S_0000",
            result: { user_code: "GW00178937", user_name: "武晓达", email: "user@gwm.cn" },
          })
        return Response.json({
          data: [{ person_number: "GW00178937", team_id: "D-001", team_name: "研发一部" }],
          errCode: 0,
          errMsg: "success",
        })
      },
    })
    const fixture = await authenticationFixture(server.url.origin)

    const login = await fixture.auth.begin("/submissions")
    const authorization = new URL(login.authorizationUrl)
    expect(authorization.origin).toBe("https://sso.example.com")
    expect(authorization.searchParams.get("mode")).toBe("TOKEN")
    expect(authorization.searchParams.get("logout")).toBe("1")
    expect(authorization.searchParams.get("redirect_url")).toBe(
      `http://127.0.0.1:4210/v1/auth/callback/${login.attemptID}`,
    )
    expect(
      await fixture.database.read(async (c) =>
        c.get<{ attempt_hash: string; return_to: string }>(
          "SELECT attempt_hash, return_to FROM login_attempts",
        ),
      ),
    ).toEqual({ attempt_hash: sha256(login.attemptID), return_to: "/submissions" })

    const result = await fixture.auth.complete(login.attemptID, "sso-sensitive-access-token")
    expect(identityRequests[0]?.searchParams.get("access_token")).toBe("sso-sensitive-access-token")
    expect(result.returnTo).toBe("/submissions")
    expect(result.session.user).toEqual({
      employeeID: "GW00178937",
      displayName: "武晓达",
      department: { id: "D-001", name: "研发一部" },
    })
    expect(result.session.roles).toEqual([])
    expect(result.session.csrfToken).toBe(result.csrfToken)
    expect(result.sessionToken).toHaveLength(43)
    expect(result.csrfToken).toHaveLength(43)
    expect(result.setCookies).toEqual([
      `ruying_market_session=${result.sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
      `ruying_market_csrf=${result.csrfToken}; Path=/; SameSite=Lax; Max-Age=43200`,
    ])

    const stored = await fixture.database.read(async (c) =>
      c.get<{ session_hash: string; csrf_hash: string }>("SELECT session_hash, csrf_hash FROM sessions"),
    )
    expect(stored).toEqual({ session_hash: sha256(result.sessionToken), csrf_hash: sha256(result.csrfToken) })
    const bytes = new TextDecoder().decode((fixture.database as SqliteDatabase).connection.serialize())
    expect(bytes).not.toContain("sso-sensitive-access-token")
    expect(bytes).not.toContain(result.sessionToken)
    expect(bytes).not.toContain(result.csrfToken)

    const logout = await fixture.auth.logout(result.sessionToken)
    expect(logout.clearCookies).toEqual([
      "ruying_market_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      "ruying_market_csrf=; Path=/; SameSite=Lax; Max-Age=0",
    ])
    expect(
      (await fixture.database.read(async (c) => c.get<{ count: number }>("SELECT count(*) AS count FROM sessions")))
        ?.count,
    ).toBe(0)
    await fixture.database.close()
  })

  test("updates trusted department names and employee transfers on login", async () => {
    const departments = [
      { team_id: "D-001", team_name: "研发一部" },
      { team_id: "D-001", team_name: "研发平台部" },
      { team_id: "D-002", team_name: "质量部" },
    ]
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/authenticate/check_token"
          ? Response.json({ key: "S_0000", result: { user_code: "E000001", user_name: "Test User" } })
          : Response.json({ data: [departments.shift()], errCode: 0, errMsg: "success" }),
    })
    const fixture = await authenticationFixture(server.url.origin)

    const first = await fixture.auth.complete((await fixture.auth.begin("/skills")).attemptID, "first")
    const renamed = await fixture.auth.complete((await fixture.auth.begin("/skills")).attemptID, "renamed")
    const transferred = await fixture.auth.complete((await fixture.auth.begin("/skills")).attemptID, "transferred")

    expect(first.session.user.department).toEqual({ id: "D-001", name: "研发一部" })
    expect(renamed.session.user.department).toEqual({ id: "D-001", name: "研发平台部" })
    expect(transferred.session.user.department).toEqual({ id: "D-002", name: "质量部" })
    expect((await fixture.auth.session(transferred.sessionToken, transferred.csrfToken)).user.department).toEqual({
      id: "D-002",
      name: "质量部",
    })
    expect(
      await fixture.database.read(async (c) =>
        c.all<{ department_id: string; display_name: string }>(
          "SELECT department_id, display_name FROM departments ORDER BY department_id",
        ),
      ),
    ).toEqual([
      { department_id: "D-001", display_name: "研发平台部" },
      { department_id: "D-002", display_name: "质量部" },
    ])
    await fixture.database.close()
  })

  test("treats an empty department lookup as absent during rollout", async () => {
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/authenticate/check_token"
          ? Response.json({ key: "S_0000", result: { user_code: "E000001", user_name: "Test User" } })
          : Response.json({ data: [], errCode: 0, errMsg: "success" }),
    })
    const fixture = await authenticationFixture(server.url.origin)

    const nullPair = await fixture.auth.complete((await fixture.auth.begin("/skills")).attemptID, "null")
    const blankPair = await fixture.auth.complete((await fixture.auth.begin("/skills")).attemptID, "blank")

    expect(nullPair.session.user.department).toBeUndefined()
    expect(blankPair.session.user.department).toBeUndefined()
    expect(
      (await fixture.database.read(async (c) => c.get<{ count: number }>("SELECT count(*) AS count FROM departments")))
        ?.count,
    ).toBe(0)
    await fixture.database.close()
  })

  test("normalizes a safe numeric department ID from the department service", async () => {
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/authenticate/check_token"
          ? Response.json({ key: "S_0000", result: { user_code: "E000001", user_name: "Test User" } })
          : Response.json({
              data: [{ person_number: "E000001", team_id: 100200300, team_name: "研发部" }],
              errCode: 0,
              errMsg: "success",
            }),
    })
    const fixture = await authenticationFixture(server.url.origin)

    const result = await fixture.auth.complete((await fixture.auth.begin("/skills")).attemptID, "numeric")

    expect(result.session.user.department).toEqual({ id: "100200300", name: "研发部" })
    await fixture.database.close()
  })

  test("hydrates a preassigned placeholder user on first SSO login and preserves the role", async () => {
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/authenticate/check_token"
          ? Response.json({ key: "S_0000", result: { user_code: "e000001", user_name: "Test User" } })
          : Response.json({ data: [], errCode: 0, errMsg: "success" }),
    })
    const fixture = await authenticationFixture(server.url.origin)
    await bootstrapAdmins(fixture.database, ["ADMIN"], fixture.clock.value)
    await createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    }).assignRole(adminPrincipal(fixture.clock.value), { employeeID: "E000001", role: "reviewer" })

    const login = await fixture.auth.begin("/admin")
    const result = await fixture.auth.complete(login.attemptID, "token")

    expect(result.session.user).toEqual({ employeeID: "E000001", displayName: "Test User" })
    expect(result.session.roles).toEqual(["reviewer"])
    expect(
      await fixture.database.read(async (c) =>
        c.get<{ display_name: string }>("SELECT display_name FROM users WHERE employee_id = ?", ["E000001"]),
      ),
    ).toEqual({ display_name: "Test User" })
    await fixture.database.close()
  })

  test("allows only declared same-site return paths", async () => {
    using server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) })
    const fixture = await authenticationFixture(server.url.origin)

    ;[
      "/skills",
      "/skills/community/my-skill",
      "/announcements",
      "/announcements/ann_abcdefgh",
      "/expert-packages",
      "/expert-packages/tech-test-automation",
      "/favorites",
      "/submissions",
      "/submissions/new",
      "/submissions/new?target=personal",
      "/submissions/new?from=sub_abcdefgh",
      "/submissions/sub_abcdefgh",
      "/submissions/sub_abcdefgh?revise=1",
      "/admin",
      "/admin/submissions/sub_abcdefgh",
      "/admin/roles",
      "/admin/audit?page=2",
      "/admin/announcements",
    ].forEach((returnTo) => expect(() => fixture.auth.begin(returnTo)).not.toThrow())
    ;[
      "https://evil.example/submissions",
      "//evil.example/submissions",
      "/skills/unknown/my-skill",
      "/skills/community/my-skill?next=https://evil.example",
      "/skills/community/%2e%2e",
      "/submissions/new#target=personal",
      "/admin/users",
      "/submissions/../../admin",
    ].forEach((returnTo) => expect(() => fixture.auth.begin(returnTo)).toThrow("returnTo is not allowed"))

    await fixture.database.close()
  })

  test("rejects unknown, expired, and replayed attempts before SSO validation", async () => {
    let calls = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/authenticate/check_token") {
          calls++
          return Response.json({ key: "S_0000", result: { user_code: "E000001", user_name: "Test User" } })
        }
        return Response.json({ data: [], errCode: 0, errMsg: "success" })
      },
    })
    const fixture = await authenticationFixture(server.url.origin)

    expect((await securityFailure(fixture.auth.complete(`login_${"x".repeat(43)}`, "token"))).code).toBe(
      "unauthenticated",
    )
    const expired = await fixture.auth.begin("/submissions")
    fixture.clock.value += 5 * 60 * 1_000
    expect((await securityFailure(fixture.auth.complete(expired.attemptID, "token"))).code).toBe("unauthenticated")
    expect(calls).toBe(0)

    const valid = await fixture.auth.begin("/submissions")
    const complete = await fixture.auth.complete(valid.attemptID, "token")
    expect(complete.session.user.employeeID).toBe("E000001")
    expect((await securityFailure(fixture.auth.complete(valid.attemptID, "token"))).code).toBe("unauthenticated")
    expect(calls).toBe(1)

    await fixture.database.close()
  })

  test("consumes attempts on SSO rejection and refuses malformed trusted identity", async () => {
    let calls = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/team")
          return Response.json({ data: [{ team_id: "D-1" }], errCode: 0, errMsg: "success" })
        calls++
        const token = url.searchParams.get("access_token")
        if (token === "rejected") return Response.json({ key: "E_0003", result: null })
        if (token === "partial")
          return Response.json({ key: "S_0000", result: { user_code: "E000001", user_name: "Test User" } })
        return Response.json({ key: "S_0000", result: { user_code: "missingdisplayname" } })
      },
    })
    const fixture = await authenticationFixture(server.url.origin)

    const rejected = await fixture.auth.begin("/submissions")
    expect((await securityFailure(fixture.auth.complete(rejected.attemptID, "rejected"))).code).toBe("unauthenticated")
    expect((await securityFailure(fixture.auth.complete(rejected.attemptID, "rejected"))).code).toBe("unauthenticated")
    expect(calls).toBe(1)

    const malformed = await fixture.auth.begin("/submissions")
    expect((await securityFailure(fixture.auth.complete(malformed.attemptID, "malformed"))).code).toBe(
      "dependency-unavailable",
    )
    const partial = await fixture.auth.begin("/submissions")
    expect((await securityFailure(fixture.auth.complete(partial.attemptID, "partial"))).code).toBe(
      "dependency-unavailable",
    )
    expect(
      (await fixture.database.read(async (c) => c.get<{ count: number }>("SELECT count(*) AS count FROM sessions")))
        ?.count,
    ).toBe(0)

    await fixture.database.close()
  })

  test("does not create a session for a disabled trusted user", async () => {
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/authenticate/check_token"
          ? Response.json({ key: "S_0000", result: { user_code: "E000001", user_name: "Test User" } })
          : Response.json({ data: [], errCode: 0, errMsg: "success" }),
    })
    const fixture = await authenticationFixture(server.url.origin)
    await fixture.database.transaction(async (c) =>
      c.run(
        "INSERT INTO users (employee_id, display_name, created_at, last_login_at, disabled_at) VALUES (?, ?, ?, ?, ?)",
        ["E000001", "Disabled User", fixture.clock.value, fixture.clock.value, fixture.clock.value],
      ),
    )

    const login = await fixture.auth.begin("/submissions")
    expect((await securityFailure(fixture.auth.complete(login.attemptID, "token"))).code).toBe("unauthenticated")
    expect(
      (await fixture.database.read(async (c) => c.get<{ count: number }>("SELECT count(*) AS count FROM sessions")))
        ?.count,
    ).toBe(0)

    await fixture.database.close()
  })

  test("serializes production Secure cookies without weakening IP-test cookies", async () => {
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/authenticate/check_token"
          ? Response.json({ key: "S_0000", result: { user_code: "E000001", user_name: "Test User" } })
          : Response.json({ data: [], errCode: 0, errMsg: "success" }),
    })
    const fixture = await authenticationFixture(server.url.origin, true)
    const login = await fixture.auth.begin("/admin")
    const result = await fixture.auth.complete(login.attemptID, "token")

    expect(result.setCookies).toEqual([
      `__Host-ruying_market_session=${result.sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
      `__Host-ruying_market_csrf=${result.csrfToken}; Path=/; Secure; SameSite=Lax; Max-Age=43200`,
    ])
    await fixture.database.close()
  })
})

async function authenticationFixture(
  identityServiceBaseUrl: string,
  cookieSecure = false,
  authentication: {
    readonly ssoCheckTokenUrl: string
    readonly ssoPlatformCode: string
    readonly departmentLookupUrl: string
    readonly departmentLookupAppCode: string
    readonly fetch: typeof fetch
  } | undefined = undefined,
) {
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
    ssoCheckTokenUrl: `${identityServiceBaseUrl}/authenticate/check_token`,
    ssoPlatformCode: "platform-test",
    departmentLookupUrl: `${identityServiceBaseUrl}/team`,
    departmentLookupAppCode: "department-test",
    apiPublicUrl: "http://127.0.0.1:4210/",
    sessionCookieName: cookieSecure ? "__Host-ruying_market_session" : "ruying_market_session",
    cookieSecure,
    loginAttemptMilliseconds: 5 * 60 * 1_000,
    sessionAbsoluteMilliseconds: 12 * 60 * 60 * 1_000,
    now: () => clock.value,
    ...authentication,
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

function adminPrincipal(now: number): Principal {
  const timestamp = new Date(now).toISOString()
  return {
    session: {
      user: { employeeID: "ADMIN", displayName: "ADMIN" },
      roles: ["admin"],
      csrfToken: "_".repeat(43),
      createdAt: timestamp,
      absoluteExpiresAt: timestamp,
      idleExpiresAt: timestamp,
    },
    csrfHash: sha256("_".repeat(43)),
  }
}
