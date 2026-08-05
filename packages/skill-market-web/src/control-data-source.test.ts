import { afterEach, describe, expect, test } from "bun:test"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { createSkillMarketControlDataSource, MarketControlError } from "./control-data-source"

const servers: Bun.Server<unknown>[] = []
const csrfToken = "c".repeat(43)
const user = { employeeID: "E000001", displayName: "Contributor" }
const metadata = {
  version: "1.0.0",
  displayName: "Safe Skill",
  description: "A safe submitted Skill",
  category: "Developer Tools",
  tags: ["review"],
  license: "MIT",
  requiresApiKey: false,
  changeNotes: "Initial submission",
} satisfies SkillMarketControl.SubmissionMetadata
const summary = {
  id: "sub_abcdefgh",
  skillID: "safe-skill",
  owner: user,
  targetVersion: "1.0.0",
  status: "validating",
  currentRevision: 1,
  version: 1,
  risk: "unknown",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
} satisfies SkillMarketControl.SubmissionSummary
const detail = {
  ...summary,
  metadata,
  revisions: [
    {
      number: 1,
      metadata,
      validationIssues: [],
      createdAt: "2026-07-16T00:00:00.000Z",
    },
  ],
  reviews: [],
  timeline: [{ status: "validating", at: "2026-07-16T00:00:00.000Z" }],
} satisfies SkillMarketControl.SubmissionDetail

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
})

describe("skill market control data source", () => {
  test("includes browser credentials and decodes the current session", async () => {
    const requests: Array<RequestInit | undefined> = []
    const server = serve(() =>
      Response.json({
        user,
        roles: ["reviewer"],
        csrfToken,
        createdAt: "2026-07-16T00:00:00.000Z",
        absoluteExpiresAt: "2026-07-16T12:00:00.000Z",
        idleExpiresAt: "2026-07-16T02:00:00.000Z",
      }),
    )
    const source = createSkillMarketControlDataSource(server.url, {
      fetcher: (input, init) => {
        requests.push(init)
        return fetch(input, init)
      },
    })

    await expect(source.auth.session()).resolves.toMatchObject({ user, roles: ["reviewer"] })
    expect(requests[0]?.credentials).toBe("include")
    expect(new Headers(requests[0]?.headers).get("accept")).toBe("application/json")
    expect(source.auth.loginUrl("/submissions/new")).toBe(`${server.url}/v1/auth/login?returnTo=%2Fsubmissions%2Fnew`)
  })

  test("reads and mutates per-user favorites with CSRF protection", async () => {
    const requests: Array<{ method: string; path: string; csrf: string | null }> = []
    const favorite = {
      source: "skillhub",
      id: "code-review",
      createdAt: "2026-07-24T00:00:00.000Z",
    } as const
    const server = serve((request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        csrf: request.headers.get("x-csrf-token"),
      })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return Response.json(request.method === "GET" ? [favorite] : favorite)
    })
    const source = createSkillMarketControlDataSource(server.url, { csrfToken: () => csrfToken })

    await expect(source.favorites.list()).resolves.toEqual([favorite])
    await expect(source.favorites.add("skillhub", "code/review")).resolves.toEqual(favorite)
    await expect(source.favorites.remove("skillhub", "code/review")).resolves.toBeUndefined()
    expect(requests).toEqual([
      { method: "GET", path: "/v1/favorites", csrf: null },
      { method: "POST", path: "/v1/favorites/skillhub/code%2Freview", csrf: csrfToken },
      { method: "DELETE", path: "/v1/favorites/skillhub/code%2Freview", csrf: csrfToken },
    ])
  })

  test("publishes announcements through the admin CSRF boundary", async () => {
    const input = {
      title: "新功能上线",
      summary: "公告摘要",
      content: "# 公告正文",
    } satisfies SkillMarketControl.AnnouncementCreateInput
    const announcement = {
      id: "ann_abcdefgh",
      ...input,
      publishedAt: "2026-07-24T00:00:00.000Z",
    }
    const requests: Array<{ path: string; method: string; csrf: string | null; body: string }> = []
    const server = serve(async (request) => {
      requests.push({
        path: new URL(request.url).pathname,
        method: request.method,
        csrf: request.headers.get("x-csrf-token"),
        body: await request.text(),
      })
      return Response.json(announcement)
    })
    const source = createSkillMarketControlDataSource(server.url, { csrfToken: () => csrfToken })

    await expect(source.announcements.publish(input)).resolves.toEqual(announcement)
    expect(requests).toEqual([
      {
        path: "/v1/admin/announcements",
        method: "POST",
        csrf: csrfToken,
        body: JSON.stringify(input),
      },
    ])
  })

  test("sends files as multipart with CSRF and a retained idempotency key", async () => {
    const requests: RequestInit[] = []
    const fields: Array<Record<string, unknown>> = []
    const server = serve(async (request) => {
      const form = await request.formData()
      const formMetadata = form.get("metadata")
      const packageFile = form.get("package")
      const iconFile = form.get("icon")
      if (typeof formMetadata !== "string") throw new Error("metadata is missing")
      fields.push({
        path: new URL(request.url).pathname,
        metadata: JSON.parse(formMetadata),
        packageName: packageFile instanceof File ? packageFile.name : undefined,
        iconName: iconFile instanceof File ? iconFile.name : undefined,
      })
      return Response.json({ submission: summary }, { status: 202 })
    })
    const source = createSkillMarketControlDataSource(server.url, {
      csrfToken: () => csrfToken,
      fetcher: (input, init) => {
        requests.push(init ?? {})
        return fetch(input, init)
      },
    })
    const packageFile = new File(["zip-body"], "safe-skill.zip", { type: "application/zip" })
    const iconFile = new File(["icon-body"], "safe-skill.png", { type: "image/png" })

    expect(source.submissions.packageUrl(summary.id)).toBe(`${server.url}/v1/submissions/${summary.id}/package`)

    await expect(
      source.submissions.create({ metadata, package: packageFile, icon: iconFile }, "upload-key-0001"),
    ).resolves.toEqual({ submission: summary })
    await expect(
      source.submissions.revise(summary.id, { expectedVersion: 1, metadata, package: packageFile }, "upload-key-0002"),
    ).resolves.toEqual({ submission: summary })

    expect(fields).toEqual([
      {
        path: "/v1/submissions",
        metadata: { target: "company", metadata },
        packageName: "safe-skill.zip",
        iconName: "safe-skill.png",
      },
      {
        path: `/v1/submissions/${summary.id}/revisions`,
        metadata: { expectedVersion: 1, metadata },
        packageName: "safe-skill.zip",
        iconName: undefined,
      },
    ])
    expect(requests).toHaveLength(2)
    expect(requests.every((request) => request.credentials === "include")).toBe(true)
    expect(requests.map((request) => new Headers(request.headers).get("x-csrf-token"))).toEqual([csrfToken, csrfToken])
    expect(requests.map((request) => new Headers(request.headers).get("idempotency-key"))).toEqual([
      "upload-key-0001",
      "upload-key-0002",
    ])
    expect(requests.every((request) => !new Headers(request.headers).has("content-type"))).toBe(true)
    const form = requests[0]?.body
    expect(form).toBeInstanceOf(FormData)
    if (!(form instanceof FormData)) throw new Error("upload body is not multipart")
    expect(form.get("package")).toMatchObject({
      name: packageFile.name,
      size: packageFile.size,
      type: packageFile.type,
    })
    expect(new Headers(requests[0]?.headers).has("cookie")).toBe(false)
    expect(new Headers(requests[0]?.headers).has("origin")).toBe(false)
  })

  test("encodes list queries and JSON moderation writes through the shared boundary", async () => {
    const requests: Array<{ path: string; query: string; init?: RequestInit }> = []
    const server = serve((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/decision")) return Response.json(detail)
      if (url.pathname === "/v1/admin/roles") return Response.json([])
      if (url.pathname === "/v1/admin/audit") return Response.json({ total: 0, page: 1, limit: 30, items: [] })
      return Response.json({ total: 0, page: 2, limit: 30, items: [] })
    })
    const source = createSkillMarketControlDataSource(server.url, {
      csrfToken: () => csrfToken,
      fetcher: (input, init) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input)
        requests.push({ path: url.pathname, query: url.search, init })
        return fetch(input, init)
      },
    })

    await source.submissions.list({ status: "pending_review", page: 2, limit: 30 })
    await source.moderation.list({ risk: "warning", submitter: "E000001", page: 2, limit: 30 })
    await source.moderation.decide(summary.id, {
      expectedVersion: 1,
      decision: "request_changes",
      comment: "Please revise",
    })
    await source.roles.list()
    await source.audit.list({ objectType: "submission", page: 1, limit: 30 })

    expect(requests.map((request) => `${request.path}${request.query}`)).toEqual([
      "/v1/submissions?status=pending_review&page=2&limit=30",
      "/v1/admin/submissions?risk=warning&submitter=E000001&page=2&limit=30",
      `/v1/admin/submissions/${summary.id}/decision`,
      "/v1/admin/roles",
      "/v1/admin/audit?objectType=submission&page=1&limit=30",
    ])
    const decision = requests[2]?.init
    expect(decision?.method).toBe("POST")
    expect(new Headers(decision?.headers).get("content-type")).toBe("application/json")
    expect(new Headers(decision?.headers).get("x-csrf-token")).toBe(csrfToken)
    expect(decision?.body).toBe(
      JSON.stringify({ expectedVersion: 1, decision: "request_changes", comment: "Please revise" }),
    )
  })

  test("reads SkillHub import progress and writes commands through the CSRF-protected JSON boundary", async () => {
    const requests: Array<{ method: string; path: string; headers: Headers; body?: string }> = []
    const status = {
      state: "running",
      sourceStatus: "fresh",
      upstreamTotal: 1,
      discovered: 1,
      pending: 0,
      running: 1,
      mirrored: 0,
      retryWait: 0,
      rejected: 0,
      uploadedBytes: 0,
      ratePerMinute: 0,
      discoveryPage: 1,
      sweep: 1,
      metadataConcurrency: 1,
      packageConcurrency: 1,
      updatedAt: "2026-07-17T00:00:00.000Z",
    } satisfies SkillMarketControl.SkillHubImportProgress
    const server = serve(async (request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        ...(request.body ? { body: await request.text() } : {}),
      })
      return Response.json(status)
    })
    const source = createSkillMarketControlDataSource(server.url, { csrfToken: () => csrfToken })

    await expect(source.skillhub.status()).resolves.toEqual(status)
    await expect(source.skillhub.command({ command: "pause" })).resolves.toEqual(status)

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /v1/admin/skillhub-import",
      "POST /v1/admin/skillhub-import/command",
    ])
    expect(requests[1]?.headers.get("x-csrf-token")).toBe(csrfToken)
    expect(requests[1]?.headers.get("idempotency-key")).toBeNull()
    expect(requests[1]?.body).toBe(JSON.stringify({ command: "pause" }))
  })

  test("uses dedicated group, sharing, and restricted catalog boundaries", async () => {
    const group = {
      id: "grp_aurora123",
      name: "Project Aurora",
      ownerEmployeeID: "E000001",
      status: "active",
      version: 1,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    } satisfies SkillMarketControl.MarketGroup
    const requests: Array<{ method: string; path: string; csrf: string | null; key: string | null; body: string }> = []
    const server = serve(async (request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        csrf: request.headers.get("x-csrf-token"),
        key: request.headers.get("idempotency-key"),
        body: request.body ? await request.text() : "",
      })
      const path = new URL(request.url).pathname
      if (path === "/v1/groups") return Response.json(request.method === "GET" ? { managed: [group], joined: [] } : group)
      if (path.endsWith("/members"))
        return Response.json({ groupID: group.id, employeeID: "E000002", createdByEmployeeID: "E000001", createdAt: group.createdAt })
      if (path.endsWith("/install-grants"))
        return Response.json({ url: "https://market.example/grants/token", expiresAt: "2026-07-16T00:05:00.000Z" })
      return Response.json(path.endsWith("/versions") ? [] : path.startsWith("/v1/restricted-skills/") ? restrictedDetail() : { submission: summary })
    })
    const source = createSkillMarketControlDataSource(server.url, { csrfToken: () => csrfToken })

    await source.groups.list()
    await source.groups.create({ name: "Project Aurora" })
    await source.groups.addMember(group.id, { expectedVersion: 1, employeeID: "E000002" })
    await source.submissions.promote(summary.id, { expectedVersion: 1, target: "department", audience: { scope: "department" } }, "promotion-key")
    await source.restricted.detail("pub_abcdefgh")
    await source.restricted.versions("pub_abcdefgh")
    await source.restricted.installGrant("pub_abcdefgh")

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /v1/groups",
      "POST /v1/groups",
      `POST /v1/groups/${group.id}/members`,
      `POST /v1/submissions/${summary.id}/promotions`,
      "GET /v1/restricted-skills/pub_abcdefgh",
      "GET /v1/restricted-skills/pub_abcdefgh/versions",
      "POST /v1/restricted-skills/pub_abcdefgh/install-grants",
    ])
    expect(requests[3]).toMatchObject({ csrf: csrfToken, key: "promotion-key" })
    expect(requests[6]).toMatchObject({ csrf: csrfToken })
  })

  test("reads TRACE evaluation progress through its independent admin endpoint", async () => {
    const evaluation = {
      total: 100,
      waiting: 0,
      pending: 50,
      running: 2,
      retryWait: 3,
      completed: 40,
      failed: 5,
      ratePerMinute: 60,
      estimatedSecondsRemaining: 55,
    } satisfies SkillMarketControl.SkillHubEvaluationProgress
    const server = serve((request) => {
      expect(new URL(request.url).pathname).toBe("/v1/admin/skillhub-evaluation")
      return Response.json(evaluation)
    })
    const source = createSkillMarketControlDataSource(server.url)

    await expect(source.skillhub.evaluation()).resolves.toEqual(evaluation)
  })

  test("covers logout, moderation operations, and role administration", async () => {
    const requests: Array<{ method: string; path: string; body?: string }> = []
    const assignment = {
      user,
      role: "reviewer" as const,
      createdBy: "E000002",
      createdAt: "2026-07-16T00:00:00.000Z",
    }
    const server = serve(async (request) => {
      const path = new URL(request.url).pathname
      requests.push({ method: request.method, path, ...(request.body ? { body: await request.text() } : {}) })
      if (path === "/v1/auth/session") return new Response(null, { status: 204 })
      if (path === "/v1/admin/roles" && request.method === "POST") return Response.json(assignment)
      if (path.startsWith("/v1/admin/roles/")) return Response.json([assignment])
      if (path.includes("/community-skills/"))
        return Response.json({
          source: "community",
          id: "safe-skill",
          version: "1.0.0",
          rowVersion: 2,
          status: path.endsWith("/delist") ? "delisted" : "published",
        })
      return Response.json(detail)
    })
    const source = createSkillMarketControlDataSource(server.url, { csrfToken: () => csrfToken })

    await source.auth.logout()
    await source.moderation.detail(summary.id)
    await source.moderation.retryPublish(summary.id, { expectedVersion: 1 })
    await source.moderation.delist("safe/skill", { expectedVersion: 1, reason: "Security review" })
    await source.moderation.restore("safe/skill", { expectedVersion: 2, reason: "Issue resolved" })
    await source.roles.assign({ employeeID: "E000001", role: "reviewer" })
    await source.roles.remove("E000001", "reviewer")

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "DELETE /v1/auth/session",
      `GET /v1/admin/submissions/${summary.id}`,
      `POST /v1/admin/submissions/${summary.id}/retry-publish`,
      "POST /v1/admin/community-skills/safe%2Fskill/delist",
      "POST /v1/admin/community-skills/safe%2Fskill/restore",
      "POST /v1/admin/roles",
      "DELETE /v1/admin/roles/E000001/reviewer",
    ])
    expect(requests[2]?.body).toBe(JSON.stringify({ expectedVersion: 1 }))
    expect(requests[3]?.body).toBe(JSON.stringify({ expectedVersion: 1, reason: "Security review" }))
    expect(requests[4]?.body).toBe(JSON.stringify({ expectedVersion: 2, reason: "Issue resolved" }))
  })

  test("preserves stable control errors and rejects malformed payloads", async () => {
    const conflict = serve(() =>
      Response.json(
        { code: "submission-conflict", message: "Refresh and retry", requestId: "req_abcdef" },
        { status: 409 },
      ),
    )
    const conflictSource = createSkillMarketControlDataSource(conflict.url)
    await expect(conflictSource.submissions.detail(summary.id)).rejects.toEqual(
      new MarketControlError(409, "submission-conflict", "Refresh and retry", "req_abcdef"),
    )

    const malformedSuccess = serve(() => Response.json({ total: "zero", items: [] }))
    const malformedSuccessSource = createSkillMarketControlDataSource(malformedSuccess.url)
    await expect(malformedSuccessSource.submissions.list({ page: 1, limit: 30 })).rejects.toBeTruthy()

    const malformedError = serve(() => Response.json({ code: "internal-stack" }, { status: 500 }))
    const malformedErrorSource = createSkillMarketControlDataSource(malformedError.url)
    await expect(malformedErrorSource.submissions.detail(summary.id)).rejects.not.toBeInstanceOf(MarketControlError)
  })

  test("requires CSRF before writes and preserves AbortSignal", async () => {
    let calls = 0
    const source = createSkillMarketControlDataSource("http://127.0.0.1:4210", {
      fetcher: () => {
        calls += 1
        return Promise.resolve(Response.json({ submission: summary }))
      },
    })
    await expect(
      source.submissions.create(
        { metadata, package: new File(["zip"], "skill.zip", { type: "application/zip" }) },
        "upload-key-0001",
      ),
    ).rejects.toThrow("CSRF")
    expect(calls).toBe(0)

    const waiting = serve(() => new Promise<Response>(() => undefined))
    const waitingSource = createSkillMarketControlDataSource(waiting.url)
    const controller = new AbortController()
    controller.abort()
    await expect(waitingSource.auth.session(controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  })

  test("allows insecure HTTP only for loopback or explicitly enabled private IPv4 testing", () => {
    expect(() => createSkillMarketControlDataSource("http://market.example.com")).toThrow("must use HTTPS")
    expect(() => createSkillMarketControlDataSource("http://10.246.13.226:4210")).toThrow("must use HTTPS")
    expect(() =>
      createSkillMarketControlDataSource("http://10.246.13.226:4210", { allowInsecurePrivateHttp: true }),
    ).not.toThrow()
    expect(() =>
      createSkillMarketControlDataSource("http://market.example.com", { allowInsecurePrivateHttp: true }),
    ).toThrow("must use HTTPS")
    expect(() => createSkillMarketControlDataSource("https://market.example.com")).not.toThrow()
  })
})

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}` }
}

function restrictedDetail() {
  return {
    id: "pub_abcdefgh",
    source: "restricted",
    sourceUrl: "https://market.example/v1/restricted-skills/pub_abcdefgh",
    name: "Restricted Skill",
    description: "Private package",
    categories: ["Internal"],
    tags: [],
    requiresApiKey: false,
    risk: "safe",
    version: "1.0.0",
    updatedAt: "2026-07-16T00:00:00.000Z",
    downloads: 0,
    favorites: 0,
    score: 0,
    featured: false,
    enterprise: false,
    visibility: "groups",
    delisted: false,
    readme: "# Restricted",
    author: { name: "Contributor" },
    versions: [],
    securityReports: [],
    package: { url: "https://market.example/private", sha256: "a".repeat(64), size: 3, files: [] },
    publicDetailUrl: "https://market.example/v1/restricted-skills/pub_abcdefgh",
  }
}
