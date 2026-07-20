import { afterEach, describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAuth } from "../src/auth"
import type { CatalogReader } from "../src/catalog-reader"
import { openDatabase } from "../src/database"
import { createMarketWebHandler } from "../src/handlers"
import { createModeration } from "../src/moderation"
import type { PrivateObjectStore } from "../src/oss"
import { MAX_CATALOG_PACKAGE_SIZE } from "../src/package-reader"
import { createSecurity } from "../src/security"
import { createSkillHubImportAdmin } from "../src/skillhub-import-admin"
import { createSkillHubImportStore } from "../src/skillhub-import-store"
import { createSubmissions } from "../src/submissions"
import { sampleCatalogReader, sampleDetail, sampleSnapshot } from "./fixture"
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

  test("binds Effect catalog headers and body to one acquired revision", async () => {
    const first = sampleSnapshot("effect-a")
    const second = sampleSnapshot("effect-b")
    const catalog: CatalogReader = {
      async index() {
        return { ...first, details: new Map() }
      },
      async list(query, current) {
        const index = current ?? { ...second, details: new Map() }
        return {
          revision: index.revision,
          sourceStatus: index.sourceStatus,
          total: index.items.length,
          page: query.page,
          limit: query.limit,
          items: index.items,
        }
      },
      async facets(current) {
        return (current ?? second).facets
      },
      async detail() {
        return undefined
      },
      async versions() {
        return undefined
      },
      async download() {
        return undefined
      },
    }
    await using fixture = await marketFixture({ catalog })

    const response = await fetch(`${fixture.url}/v1/catalog/skills?page=1&limit=30`)
    const page = Schema.decodeUnknownSync(SkillMarket.Page)(await response.json())

    expect(response.headers.get("x-skill-market-revision")).toBe("effect-a")
    expect(page.revision).toBe("effect-a")
  })

  test("serves verified packages through GET and HEAD with bounded delivery metrics", async () => {
    await using fixture = await marketFixture()
    const get = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(get.status).toBe(200)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(fixture.packageBody)
    expect(get.headers.get("content-type")).toBe("application/zip")
    expect(get.headers.get("content-length")).toBe(String(fixture.packageBody.byteLength))
    expect(get.headers.get("etag")).toBe(`"${fixture.packageSha256}"`)
    expect(get.headers.get("x-content-sha256")).toBe(fixture.packageSha256)
    expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(get.headers.get("content-disposition")).toBe('attachment; filename="skillhub-code-review-1.0.0.zip"')
    expect(get.headers.get("x-content-type-options")).toBe("nosniff")

    const head = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`, { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(head.headers.get("content-type")).toBe("application/zip")
    expect(head.headers.get("content-length")).toBe(String(fixture.packageBody.byteLength))
    expect(head.headers.get("etag")).toBe(`"${fixture.packageSha256}"`)
    expect(head.headers.get("x-content-sha256")).toBe(fixture.packageSha256)
    expect(head.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(head.headers.get("content-disposition")).toBe('attachment; filename="skillhub-code-review-1.0.0.zip"')
    expect(head.headers.get("x-content-type-options")).toBe("nosniff")
    expect(fixture.packageGets).toBe(2)
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          success: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
        },
      },
      {
        skill_market_package_delivery: {
          success: 1,
          source: "skillhub",
          id: "code-review",
          method: "HEAD",
        },
      },
    ])

    fixture.objects.delete(`skill-market/packages/${fixture.packageSha256}.zip`)
    const failed = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(failed.status).toBe(502)
    const failedBody = await failed.text()
    const failedJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(failedBody)
    const problem = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        source: Schema.String,
        id: Schema.String,
        requestId: Schema.String,
      }),
    )(failedJson)
    expect(failedJson).toEqual({
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      source: "skillhub",
      id: "code-review",
      requestId: problem.requestId,
    })
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          success: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
        },
      },
      {
        skill_market_package_delivery: {
          success: 1,
          source: "skillhub",
          id: "code-review",
          method: "HEAD",
        },
      },
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
          phase: "head",
          request_id: problem.requestId,
        },
      },
    ])
    const publicEvidence = `${failedBody}\n${JSON.stringify(fixture.metrics)}`
    expect(publicEvidence).not.toContain("https://attacker.example/never-fetch.zip")
    expect(publicEvidence).not.toContain(fixture.trustedKey)
  })

  test("correlates snapshot delivery failures without exposing dependency details", async () => {
    await using fixture = await marketFixture({ snapshotFailure: true })
    const failed = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(failed.status).toBe(503)
    const failedBody = await failed.text()
    const failedJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(failedBody)
    const problem = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        requestId: Schema.String,
      }),
    )(failedJson)
    expect(failedJson).toEqual({
      code: "market-unavailable",
      message: "Skill 市场暂不可用",
      requestId: problem.requestId,
    })
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
          phase: "snapshot",
          request_id: problem.requestId,
        },
      },
    ])
    expect(`${failedBody}\n${JSON.stringify(fixture.metrics)}`).not.toContain("snapshot unavailable")
  })

  test.each([
    {
      detail: "absent" as const,
      status: 404,
      code: "skill-market-not-found",
      message: "Skill 包不存在",
      phase: "detail",
    },
    {
      detail: "delisted" as const,
      status: 404,
      code: "skill-market-not-found",
      message: "Skill 包不存在",
      phase: "detail",
    },
    {
      detail: "oversize" as const,
      status: 413,
      code: "skill-market-package-too-large",
      message: "Skill 包超过大小限制",
      phase: "declared-size",
    },
  ])("maps $detail packages through the Effect delivery route", async (options) => {
    await using fixture = await marketFixture({ packageDetail: options.detail })
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(response.status).toBe(options.status)
    const responseBody = await response.text()
    const responseJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(responseBody)
    const problem = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        requestId: Schema.String,
        source: Schema.String,
        id: Schema.String,
      }),
    )(responseJson)
    expect(responseJson).toEqual({
      code: options.code,
      message: options.message,
      source: "skillhub",
      id: "code-review",
      requestId: problem.requestId,
    })
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
          phase: options.phase,
          request_id: problem.requestId,
        },
      },
    ])
    expect(fixture.packageHeads).toBe(0)
    expect(fixture.packageGets).toBe(0)
    const publicEvidence = `${responseBody}\n${JSON.stringify(fixture.metrics)}`
    expect(publicEvidence).not.toContain("https://attacker.example/never-fetch.zip")
    expect(publicEvidence).not.toContain(fixture.trustedKey)
  })

  test.each([
    {
      failure: "stored-oversize" as const,
      status: 413,
      code: "skill-market-package-too-large",
      message: "Skill 包超过大小限制",
      phase: "stored-size",
      heads: 1,
      gets: 0,
    },
    {
      failure: "get" as const,
      status: 502,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      phase: "get",
      heads: 1,
      gets: 1,
    },
    {
      failure: "stored-size" as const,
      status: 502,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      phase: "stored-size",
      heads: 1,
      gets: 0,
    },
    {
      failure: "body-size" as const,
      status: 502,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      phase: "body-size",
      heads: 1,
      gets: 1,
    },
    {
      failure: "sha256" as const,
      status: 502,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      phase: "sha256",
      heads: 1,
      gets: 1,
    },
  ])("maps $failure verification failures through the Effect delivery route", async (options) => {
    await using fixture = await marketFixture({ packageFailure: options.failure })
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(response.status).toBe(options.status)
    const responseBody = await response.text()
    const responseJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(responseBody)
    const problem = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        requestId: Schema.String,
        source: Schema.String,
        id: Schema.String,
      }),
    )(responseJson)
    expect(responseJson).toEqual({
      code: options.code,
      message: options.message,
      source: "skillhub",
      id: "code-review",
      requestId: problem.requestId,
    })
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
          phase: options.phase,
          request_id: problem.requestId,
        },
      },
    ])
    expect(fixture.packageHeads).toBe(options.heads)
    expect(fixture.packageGets).toBe(options.gets)
    const publicEvidence = `${responseBody}\n${JSON.stringify(fixture.metrics)}`
    expect(publicEvidence).not.toContain("https://attacker.example/never-fetch.zip")
    expect(publicEvidence).not.toContain(fixture.trustedKey)
  })

  test.each([
    {
      name: "absent",
      fixture: { packageDetail: "absent" as const },
      status: 404,
      phase: "detail",
    },
    {
      name: "declared oversize",
      fixture: { packageDetail: "oversize" as const },
      status: 413,
      phase: "declared-size",
    },
    {
      name: "GET-stage failure",
      fixture: { packageFailure: "get" as const },
      status: 502,
      phase: "get",
    },
  ])("returns an empty HEAD $name problem with bounded telemetry", async (options) => {
    await using fixture = await marketFixture(options.fixture)
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`, {
      method: "HEAD",
    })
    expect(response.status).toBe(options.status)
    expect(await response.text()).toBe("")
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "HEAD",
          phase: options.phase,
          request_id: expect.any(String),
        },
      },
    ])
    const publicEvidence = JSON.stringify(fixture.metrics)
    expect(publicEvidence).not.toContain("https://attacker.example/never-fetch.zip")
    expect(publicEvidence).not.toContain(fixture.trustedKey)
  })

  test("returns an empty HEAD snapshot problem with bounded telemetry", async () => {
    await using fixture = await marketFixture({ snapshotFailure: true })
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`, {
      method: "HEAD",
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toBe("")
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "HEAD",
          phase: "snapshot",
          request_id: expect.any(String),
        },
      },
    ])
    expect(JSON.stringify(fixture.metrics)).not.toContain("snapshot unavailable")
  })

  test("isolates encoded traversal and never fetches the catalog package URL", async () => {
    const state = { canaryConnections: 0 }
    const canary = createServer((socket) => {
      state.canaryConnections++
      socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      canary.once("error", reject)
      canary.listen(0, "127.0.0.1", resolve)
    })
    const address = canary.address()
    if (!address || typeof address === "string") throw new Error("canary did not bind a TCP port")
    try {
      const packageUrl = `https://127.0.0.1:${address.port}/never-fetch.zip`
      await using valid = await marketFixture({ packageUrl })
      const delivered = await fetch(`${valid.url}/v1/catalog/skills/skillhub/code-review/package`)
      expect(delivered.status).toBe(200)
      expect(state.canaryConnections).toBe(0)
      expect(valid.storageKeys).toEqual([valid.trustedKey, valid.trustedKey])

      await using escaped = await marketFixture({ packageUrl })
      const response = await fetch(`${escaped.url}/v1/catalog/skills/skillhub/%2e%2e%2fprivate/package`)
      expect(response.status).toBe(404)
      const problem = await response.json()
      expect(problem).toEqual({
        code: "skill-market-not-found",
        message: "Skill 包不存在",
        requestId: expect.any(String),
        source: "skillhub",
        id: "../private",
      })
      expect(state.canaryConnections).toBe(0)
      expect(escaped.storageKeys).toEqual([])
      expect(escaped.metrics).toEqual([
        {
          skill_market_package_delivery: {
            failure: 1,
            source: "skillhub",
            id: "../private",
            method: "GET",
            phase: "detail",
            request_id: Schema.decodeUnknownSync(Schema.Struct({ requestId: Schema.String }))(problem).requestId,
          },
        },
      ])
      const publicEvidence = `${JSON.stringify(problem)}\n${JSON.stringify(escaped.metrics)}`
      expect(publicEvidence).not.toContain(packageUrl)
      expect(publicEvidence).not.toContain(escaped.trustedKey)
    } finally {
      await new Promise<void>((resolve, reject) => {
        canary.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  test.each(["%", "%ZZ"])("bounds malformed Effect package ID encoding %s", async (id) => {
    await using fixture = await marketFixture()
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/${id}/package`)

    expect([400, 404]).toContain(response.status)
    const body = await response.text()
    expect(body.length).toBeLessThan(1_000)
    expect(body).not.toContain("URIError")
    expect(body).not.toContain("decodeURIComponent")
    expect(body).not.toContain(fixture.trustedKey)
    expect(body).not.toContain("https://attacker.example/never-fetch.zip")
    expect(fixture.storageKeys).toEqual([])
  })

  test("sanitizes schema-valid package identity in production attachment filenames", async () => {
    await using fixture = await marketFixture({ packageID: "code+review", packageVersion: "1.0.0+build" })
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code+review/package`)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="skillhub-code_review-1.0.0_build.zip"',
    )
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

  test("preassigns roles over HTTP and reports duplicate assignments clearly", async () => {
    await using fixture = await marketFixture()
    fixture.database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
      ["E123456", "E123456", now, now],
    )
    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, ?, ?, ?)",
      ["E123456", "admin", null, now],
    )
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fadmin%2Froles`, { redirect: "manual" })
    const session = await loginSession(fixture, login, "/admin/roles")
    const request = () =>
      fetch(`${fixture.url}/v1/admin/roles`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin: webOrigin,
          "x-csrf-token": session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ employeeID: "future-user", role: "reviewer" }),
      })

    const assigned = await request()
    expect(assigned.status).toBe(200)
    expect(await assigned.json()).toMatchObject({
      user: { employeeID: "future-user", displayName: "future-user" },
      role: "reviewer",
    })

    const duplicate = await request()
    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({
      code: "invalid-request",
      message: "该用户已拥有此角色",
      requestId: expect.any(String),
    })
  })

  test("returns durable SkillHub import progress to an authenticated admin", async () => {
    await using fixture = await marketFixture()
    fixture.database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
      ["E123456", "E123456", now, now],
    )
    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, ?, ?, ?)",
      ["E123456", "admin", null, now],
    )
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fadmin%2Fskillhub`, { redirect: "manual" })
    const session = await loginSession(fixture, login, "/admin/skillhub")
    const response = await fetch(`${fixture.url}/v1/admin/skillhub-import`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })

    expect(response.status).toBe(200)
    expect(Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportProgress)(await response.json())).toMatchObject({
      pending: 0,
      running: 0,
      mirrored: 0,
      retryWait: 0,
      rejected: 0,
    })
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

async function marketFixture(
  options: {
    snapshotFailure?: boolean
    catalog?: CatalogReader
    packageDetail?: "present" | "absent" | "delisted" | "oversize"
    packageFailure?: "stored-oversize" | "get" | "stored-size" | "body-size" | "sha256"
    packageUrl?: string
    packageID?: string
    packageVersion?: string
  } = {},
) {
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
  const packageBody = new TextEncoder().encode("verified package from Effect HttpApi")
  const packageSha256 = new Bun.CryptoHasher("sha256").update(packageBody).digest("hex")
  const trustedKey = `skill-market/packages/${packageSha256}.zip`
  const storedPackageBody =
    options.packageFailure === "body-size"
      ? new Uint8Array([...packageBody, 0])
      : options.packageFailure === "sha256"
        ? packageBody.map((value, index) => (index === 0 ? value ^ 1 : value))
        : packageBody
  const objects = new Map<string, Uint8Array>([[trustedKey, storedPackageBody]])
  const metrics: Array<Readonly<Record<string, unknown>>> = []
  const state = { privateWrites: 0, packageHeads: 0, packageGets: 0, storageKeys: [] as string[] }
  const store: PrivateObjectStore = {
    async put(key, body) {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
    },
    async get(key) {
      state.storageKeys.push(key)
      const body = objects.get(key)
      if (!body) throw new Error("object is missing")
      if (key === trustedKey) state.packageGets++
      if (key === trustedKey && options.packageFailure === "get") throw new Error("GET dependency sentinel")
      return body
    },
    async head(key) {
      state.storageKeys.push(key)
      const body = objects.get(key)
      if (!body) throw new Error("object is missing")
      if (key === trustedKey) state.packageHeads++
      if (key === trustedKey && options.packageFailure === "stored-oversize")
        return { size: MAX_CATALOG_PACKAGE_SIZE + 1 }
      if (key === trustedKey && options.packageFailure === "stored-size") return { size: packageBody.byteLength + 1 }
      if (key === trustedKey && options.packageFailure === "body-size") return { size: packageBody.byteLength }
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
  const skillhubImportAdmin = createSkillHubImportAdmin({
    database,
    security,
    imports: createSkillHubImportStore({ database, now: () => now }),
    now: () => now,
  })
  const snapshot = sampleSnapshot()
  snapshot.details.delete("skillhub:code-review")
  snapshot.details.set(
    `skillhub:${options.packageID ?? "code-review"}`,
    sampleDetail({
      id: options.packageID ?? "code-review",
      delisted: options.packageDetail === "delisted",
      version: options.packageVersion ?? "1.0.0",
      package: {
        ...sampleDetail().package,
        url: options.packageUrl ?? "https://attacker.example/never-fetch.zip",
        sha256: packageSha256,
        size: options.packageDetail === "oversize" ? MAX_CATALOG_PACKAGE_SIZE + 1 : packageBody.byteLength,
      },
    }),
  )
  if (options.packageDetail === "absent") snapshot.details.delete(`skillhub:${options.packageID ?? "code-review"}`)
  const web = createMarketWebHandler({
    catalog:
      options.catalog ??
      sampleCatalogReader(
        snapshot,
        options.snapshotFailure
          ? () => {
              throw new Error("snapshot unavailable with private dependency detail")
            }
          : undefined,
      ),
    auth,
    security,
    submissions,
    moderation,
    skillhubImportAdmin,
    store,
    privatePrefix: "skill-market-private",
    publicPrefix: "skill-market",
    webOrigin,
    webBaseUrl,
    sessionCookieName: "ruying_market_session",
    cookieSecure: false,
    sessionCookieMaxAgeSeconds: 12 * 60 * 60,
    emit: (metric) => metrics.push(metric),
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request) })
  return {
    url: server.url.origin,
    database,
    objects,
    metrics,
    packageBody,
    packageSha256,
    trustedKey,
    storageKeys: state.storageKeys,
    get packageHeads() {
      return state.packageHeads
    },
    get packageGets() {
      return state.packageGets
    },
    get privateWrites() {
      return state.privateWrites
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
      await web.dispose()
      database.close()
    },
  }
}
