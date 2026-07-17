import { afterEach, describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAuth } from "../src/auth"
import { openDatabase } from "../src/database"
import { createMarketWebHandler } from "../src/handlers"
import { createModeration } from "../src/moderation"
import type { PrivateObjectStore } from "../src/oss"
import { createSecurity } from "../src/security"
import { createSkillHubImportAdmin } from "../src/skillhub-import-admin"
import { createSkillHubImportStore } from "../src/skillhub-import-store"
import { createSubmissions } from "../src/submissions"
import { sampleSnapshot } from "./fixture"
import { makeStoredZip } from "./zip"

const directories: string[] = []
const webOrigin = "http://127.0.0.1:4211"
const webBaseUrl = `${webOrigin}/ai-coding/ruying-code/skill-market/`
const now = Date.parse("2026-07-15T00:00:00.000Z")

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("skill market control HTTP", () => {
  test("serves the public catalog with wildcard GET, HEAD, and OPTIONS behavior", async () => {
    await using fixture = await marketFixture()
    const page = await fetch(`${fixture.url}/v1/catalog/skills?page=1&limit=30`)
    expect(page.status).toBe(200)
    expect(page.headers.get("access-control-allow-origin")).toBe("*")
    expect(page.headers.has("access-control-allow-credentials")).toBe(false)
    expect(page.headers.get("x-skill-market-revision")).toBe("r1")
    expect(Schema.decodeUnknownSync(SkillMarket.Page)(await page.json()).items).toHaveLength(1)

    const head = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review`, { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(head.headers.get("x-skill-market-revision")).toBe("r1")

    const preflight = await fetch(`${fixture.url}/v1/catalog/skills`, { method: "OPTIONS" })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS")
  })

  test("keeps delisted versions and downloads unavailable through the Effect API", async () => {
    const snapshot = sampleSnapshot()
    snapshot.details.set(
      "skillhub:code-review",
      Schema.decodeUnknownSync(SkillMarket.Detail)({
        ...snapshot.details.get("skillhub:code-review"),
        delisted: true,
      }),
    )
    await using fixture = await marketFixture(snapshot)
    for (const suffix of ["versions", "download"]) {
      const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/${suffix}`)
      expect(response.status).toBe(404)
    }
  })

  test("completes login, returns a private session, enforces CSRF, and logs out", async () => {
    await using fixture = await marketFixture()
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fsubmissions`, {
      headers: { origin: webOrigin },
      redirect: "manual",
    })

    expect(login.status).toBe(302)
    expect(login.headers.get("location")).toStartWith("https://sso.example.com/login?")
    expect(login.headers.get("access-control-allow-origin")).toBe(webOrigin)
    expect(login.headers.get("access-control-allow-credentials")).toBe("true")
    expect(login.headers.get("vary")).toContain("Origin")
    expect(login.headers.get("cache-control")).toBe("no-store")
    expect(login.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")

    const session = await loginSession(fixture, login)
    const current = await fetch(`${fixture.url}/v1/auth/session`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(current.status).toBe(200)
    expect(await current.json()).toMatchObject({ user: { employeeID: "E123456", displayName: "CONTRIBUTOR" } })

    const preflight = await fetch(`${fixture.url}/v1/auth/session`, {
      method: "OPTIONS",
      headers: {
        origin: webOrigin,
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "x-csrf-token",
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe(webOrigin)
    expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE")
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-CSRF-Token")

    const rejected = await fetch(`${fixture.url}/v1/auth/session`, {
      method: "DELETE",
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toMatchObject({ code: "csrf-invalid" })

    const logout = await fetch(`${fixture.url}/v1/auth/session`, {
      method: "DELETE",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
      },
    })
    expect(logout.status).toBe(204)
    expect(logout.headers.getSetCookie().join("\n")).toContain("Max-Age=0")

    const loggedOut = await fetch(`${fixture.url}/v1/auth/session`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(await loggedOut.json()).toBeNull()
  })

  test("streams a submission into quarantine and rejects access outside the user's role", async () => {
    await using fixture = await marketFixture()
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fsubmissions`, { redirect: "manual" })
    const session = await loginSession(fixture, login)

    const anonymous = await fetch(`${fixture.url}/v1/submissions`)
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ code: "unauthenticated" })

    const form = new FormData()
    form.set(
      "metadata",
      JSON.stringify({
        version: "1.0.0",
        displayName: "Safe Skill",
        description: "A safe submitted skill",
        category: "Developer Tools",
        tags: ["review"],
        license: "MIT",
        requiresApiKey: false,
        changeNotes: "Initial submission",
      }),
    )
    form.set(
      "package",
      new Blob(
        [
          makeStoredZip({
            "SKILL.md": "---\nname: safe-skill\ndescription: A safe submitted skill\nlicense: MIT\n---\n# Safe Skill\n",
          }),
        ],
        { type: "application/zip" },
      ),
      "safe-skill.zip",
    )
    const created = await fetch(`${fixture.url}/v1/submissions`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "idempotency-key": "submission-http-test-1",
      },
      body: form,
    })
    expect(created.status).toBe(202)
    const accepted = Schema.decodeUnknownSync(SkillMarketControl.AcceptedSubmission)(await created.json())
    expect(accepted.submission).toMatchObject({ skillID: "safe-skill", status: "validating" })
    expect(fixture.privateWrites).toBeGreaterThan(0)
    expect([...fixture.objects.keys()].some((key) => key.endsWith("/package.zip"))).toBe(true)

    const detail = await fetch(`${fixture.url}/v1/submissions/${accepted.submission.id}`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ id: accepted.submission.id, skillID: "safe-skill" })

    const admin = await fetch(`${fixture.url}/v1/admin/submissions`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(admin.status).toBe(403)
    expect(await admin.json()).toMatchObject({ code: "forbidden" })
  })

  test("returns bounded stable errors for malformed control requests without leaking private data", async () => {
    await using fixture = await marketFixture()
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fadmin`, { redirect: "manual" })
    const session = await loginSession(fixture, login, "/admin")
    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, 'reviewer', ?, ?)",
      ["E123456", "E123456", now],
    )

    const malformedJson = await fetch(`${fixture.url}/v1/admin/submissions/sub_abcdefgh/decision`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: '{"expectedVersion":',
    })
    expect(malformedJson.status).toBe(400)
    const jsonBody = await malformedJson.text()
    expect(jsonBody).toContain('"code":"invalid-request"')
    expect(jsonBody).not.toContain("SyntaxError")
    expect(jsonBody).not.toContain("skill-market-private")

    const malformedMultipart = await fetch(`${fixture.url}/v1/submissions`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "idempotency-key": "malformed-multipart-1",
        "content-type": "multipart/form-data; boundary=broken",
      },
      body: "not-a-multipart-body",
    })
    expect(malformedMultipart.status).toBe(400)
    expect(await malformedMultipart.json()).toMatchObject({ code: "invalid-request" })

    const unsupported = await fetch(`${fixture.url}/v1/admin/submissions/sub_abcdefgh/decision`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "content-type": "text/plain",
      },
      body: "not-json",
    })
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toMatchObject({ code: "invalid-request" })

    const evilPreflight = await fetch(`${fixture.url}/v1/admin/roles`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    })
    expect(evilPreflight.status).toBe(204)
    expect(evilPreflight.headers.has("access-control-allow-origin")).toBe(false)
  })

  test("serves audited SkillHub import controls only to administrators", async () => {
    await using fixture = await marketFixture()
    const anonymous = await fetch(`${fixture.url}/v1/admin/skillhub-import`)
    expect(anonymous.status).toBe(401)

    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fadmin`, { redirect: "manual" })
    const session = await loginSession(fixture, login, "/admin")
    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, 'reviewer', ?, ?)",
      ["E123456", "E123456", now],
    )

    const reviewer = await fetch(`${fixture.url}/v1/admin/skillhub-import`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(reviewer.status).toBe(403)
    expect(await reviewer.json()).toMatchObject({ code: "forbidden" })

    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, 'admin', ?, ?)",
      ["E123456", "E123456", now],
    )
    const generation = fixture.imports.beginGeneration(1)
    fixture.imports.recordPage(generation.id, 1, [skillHubListRecord("http-skill")])

    const status = await fetch(`${fixture.url}/v1/admin/skillhub-import`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      state: "running",
      pending: 1,
      metadataConcurrency: 3,
      packageConcurrency: 4,
    })
    expect(fixture.workReady).toBe(0)
    expect(fixture.skillhubWorkReady).toBe(0)

    const missingCsrf = await fetch(`${fixture.url}/v1/admin/skillhub-import/command`, {
      method: "POST",
      headers: { cookie: session.cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({ command: "pause" }),
    })
    expect(missingCsrf.status).toBe(403)

    const command = await fetch(`${fixture.url}/v1/admin/skillhub-import/command`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "content-type": "application/json",
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify({ command: "pause" }),
    })
    expect(command.status).toBe(200)
    expect(await command.json()).toMatchObject({ state: "paused" })
    expect(fixture.workReady).toBe(0)
    expect(fixture.skillhubWorkReady).toBe(0)

    const resumed = await fetch(`${fixture.url}/v1/admin/skillhub-import/command`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "content-type": "application/json",
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify({ command: "resume" }),
    })
    expect(resumed.status).toBe(200)
    expect(fixture.workReady).toBe(0)
    expect(fixture.skillhubWorkReady).toBe(1)

    const retried = await fetch(`${fixture.url}/v1/admin/skillhub-import/command`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "content-type": "application/json",
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify({ command: "retry-wait" }),
    })
    expect(retried.status).toBe(200)
    expect(fixture.workReady).toBe(0)
    expect(fixture.skillhubWorkReady).toBe(2)

    const afterCommandStatus = await fetch(`${fixture.url}/v1/admin/skillhub-import`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(afterCommandStatus.status).toBe(200)
    expect(fixture.workReady).toBe(0)
    expect(fixture.skillhubWorkReady).toBe(2)

    const invalid = await fetch(`${fixture.url}/v1/admin/skillhub-import/command`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "content-type": "application/json",
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify({ command: "retry-rejected", slugs: [] }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: "invalid-request" })
  })
})

async function loginSession(
  fixture: Awaited<ReturnType<typeof marketFixture>>,
  login: Response,
  returnTo = "/submissions",
) {
  const authorization = new URL(login.headers.get("location")!)
  const callback = new URL(authorization.searchParams.get("redirect_url")!)
  const response = await fetch(`${fixture.url}${callback.pathname}?access_token=sso-token`, {
    headers: { origin: webOrigin },
    redirect: "manual",
  })
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(new URL(returnTo.slice(1), webBaseUrl).href)
  const setCookies = response.headers.getSetCookie()
  expect(setCookies).toHaveLength(2)
  expect(setCookies.every((value) => value.includes("Max-Age=43200"))).toBe(true)
  const cookies = setCookies.map((value) => value.split(";", 1)[0])
  const csrf = cookies.find((value) => value.startsWith("ruying_market_csrf="))?.split("=", 2)[1]
  expect(csrf).toHaveLength(43)
  if (!csrf) throw new Error("login did not set a CSRF cookie")
  return { cookie: cookies.join("; "), csrf }
}

async function marketFixture(snapshot = sampleSnapshot()) {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-control-http-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const security = createSecurity({
    database,
    webOrigin,
    sessionIdleMilliseconds: 2 * 60 * 60 * 1_000,
    sessionAbsoluteMilliseconds: 12 * 60 * 60 * 1_000,
    now: () => now,
  })
  const provisioningFetch: typeof fetch = Object.assign(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ status: "ready", key: "must-not-leak", tokenName: "E123456-CONTRIBUTOR" }),
    { preconnect: fetch.preconnect },
  )
  const auth = createAuth({
    database,
    security,
    ssoLoginUrl: "https://sso.example.com/login",
    adminApiBaseUrl: "https://admin.example.com",
    apiPublicUrl: "http://127.0.0.1:4210",
    sessionCookieName: "ruying_market_session",
    cookieSecure: false,
    loginAttemptMilliseconds: 5 * 60 * 1_000,
    sessionAbsoluteMilliseconds: 12 * 60 * 60 * 1_000,
    now: () => now,
    fetch: provisioningFetch,
  })
  const objects = new Map<string, Uint8Array>()
  const state = { privateWrites: 0, workReady: 0, skillhubWorkReady: 0 }
  const store: PrivateObjectStore = {
    async put(key, body) {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
    },
    async get(key) {
      const body = objects.get(key)
      if (!body) throw new Error("object is missing")
      return body
    },
    async head(key) {
      const body = objects.get(key)
      if (!body) throw new Error("object is missing")
      return { size: body.byteLength }
    },
    async putPrivate(key, body) {
      state.privateWrites++
      objects.set(key, new Uint8Array(await new Blob(await Array.fromAsync(body)).arrayBuffer()))
    },
    async copy(source, target) {
      const body = objects.get(source)
      if (!body) throw new Error("object is missing")
      objects.set(target, body.slice())
    },
    async delete(key) {
      objects.delete(key)
    },
  }
  const submissions = createSubmissions({ database, now: () => now })
  const moderation = createModeration({ database, security, now: () => now })
  const imports = createSkillHubImportStore({
    database,
    now: () => now,
    metadataConcurrency: 3,
    packageConcurrency: 4,
  })
  const skillhubImportAdmin = createSkillHubImportAdmin({ database, security, imports, now: () => now })
  const web = createMarketWebHandler({
    loadSnapshot: async () => snapshot,
    auth,
    security,
    submissions,
    moderation,
    skillhubImportAdmin,
    store,
    privatePrefix: "skill-market-private",
    webOrigin,
    webBaseUrl,
    sessionCookieName: "ruying_market_session",
    cookieSecure: false,
    sessionCookieMaxAgeSeconds: 12 * 60 * 60,
    onWorkReady: () => {
      state.workReady++
    },
    onSkillHubWorkReady: () => {
      state.skillhubWorkReady++
    },
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request) })
  return {
    url: server.url.origin,
    database,
    imports,
    objects,
    get privateWrites() {
      return state.privateWrites
    },
    get workReady() {
      return state.workReady
    },
    get skillhubWorkReady() {
      return state.skillhubWorkReady
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
      await web.dispose()
      database.close()
    },
  }
}

function skillHubListRecord(slug: string) {
  return {
    category: "Developer Tools",
    description: `${slug} description`,
    downloads: 1,
    installs: 1,
    name: slug,
    ownerName: "SkillHub",
    score: 1,
    slug,
    source: "skillhub",
    stars: 1,
    subCategories: [],
    updated_at: now,
    version: "1.0.0",
  }
}
