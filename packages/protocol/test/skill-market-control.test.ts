import { expect, test } from "bun:test"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { SkillMarketApi, SkillMarketCatalogApi } from "../src/skill-market-api"

const expected = [
  ["skillMarket.auth.login", "GET", "/v1/auth/login"],
  ["skillMarket.auth.callback", "GET", "/v1/auth/callback/:attemptID"],
  ["skillMarket.auth.session", "GET", "/v1/auth/session"],
  ["skillMarket.auth.logout", "DELETE", "/v1/auth/session"],
  ["skillMarket.announcements.list", "GET", "/v1/catalog/announcements"],
  ["skillMarket.announcements.detail", "GET", "/v1/catalog/announcements/:announcementID"],
  ["skillMarket.expertPackages.list", "GET", "/v1/catalog/expert-packages"],
  ["skillMarket.expertPackages.detail", "GET", "/v1/catalog/expert-packages/:slug"],
  ["skillMarket.favorites.list", "GET", "/v1/favorites"],
  ["skillMarket.favorites.add", "POST", "/v1/favorites/:source/:id"],
  ["skillMarket.favorites.remove", "DELETE", "/v1/favorites/:source/:id"],
  ["skillMarket.submissions.list", "GET", "/v1/submissions"],
  ["skillMarket.submissions.create", "POST", "/v1/submissions"],
  ["skillMarket.submissions.detail", "GET", "/v1/submissions/:submissionID"],
  ["skillMarket.submissions.package", "GET", "/v1/submissions/:submissionID/package"],
  ["skillMarket.submissions.packageHead", "HEAD", "/v1/submissions/:submissionID/package"],
  ["skillMarket.submissions.revise", "POST", "/v1/submissions/:submissionID/revisions"],
  ["skillMarket.admin.submissions.list", "GET", "/v1/admin/submissions"],
  ["skillMarket.admin.submissions.detail", "GET", "/v1/admin/submissions/:submissionID"],
  ["skillMarket.admin.submissions.decision", "POST", "/v1/admin/submissions/:submissionID/decision"],
  ["skillMarket.admin.submissions.retry", "POST", "/v1/admin/submissions/:submissionID/retry-publish"],
  ["skillMarket.admin.skillhub.status", "GET", "/v1/admin/skillhub-import"],
  ["skillMarket.admin.skillhub.command", "POST", "/v1/admin/skillhub-import/command"],
  ["skillMarket.admin.skillhub.evaluation", "GET", "/v1/admin/skillhub-evaluation"],
  ["skillMarket.admin.announcements.create", "POST", "/v1/admin/announcements"],
  ["skillMarket.admin.roles.list", "GET", "/v1/admin/roles"],
  ["skillMarket.admin.roles.create", "POST", "/v1/admin/roles"],
  ["skillMarket.admin.roles.delete", "DELETE", "/v1/admin/roles/:employeeID/:role"],
  ["skillMarket.admin.audit.list", "GET", "/v1/admin/audit"],
  ["skillMarket.admin.community.delist", "POST", "/v1/admin/community-skills/:skillID/delist"],
  ["skillMarket.admin.community.restore", "POST", "/v1/admin/community-skills/:skillID/restore"],
] as const

test("full market api declares every announcement, expert package, favorite, auth, submission, and admin operation", () => {
  const endpoints: Array<readonly [string, string, string]> = []
  HttpApi.reflect(SkillMarketApi, {
    onGroup() {},
    onEndpoint({ endpoint }) {
      endpoints.push([endpoint.name, endpoint.method, endpoint.path])
    },
  })
  expect(endpoints.filter(([name]) => !name.startsWith("skillMarket.catalog")).toSorted()).toEqual(
    [...expected].toSorted(),
  )
})

test("catalog-only api remains anonymous and isolated from control middleware", () => {
  HttpApi.reflect(SkillMarketCatalogApi, {
    onGroup() {},
    onEndpoint({ endpoint }) {
      expect(endpoint.middlewares.size).toBe(0)
    },
  })
})

test("submission writes are streaming multipart operations", () => {
  const document = OpenApi.fromApi(SkillMarketApi)
  expect(JSON.stringify(document.paths["/v1/submissions"]?.post?.requestBody)).toContain("multipart/form-data")
  expect(JSON.stringify(document.paths["/v1/submissions/{submissionID}/revisions"]?.post?.requestBody)).toContain(
    "multipart/form-data",
  )
})

test("openapi marks cookie sessions and csrf writes without protecting the public catalog", () => {
  const document = OpenApi.fromApi(SkillMarketApi)
  expect(document.paths["/v1/catalog/skills"]?.get?.security).toEqual([])
  expect(document.paths["/v1/catalog/announcements"]?.get?.security).toEqual([])
  expect(document.paths["/v1/submissions"]?.get?.security).toHaveLength(1)
  expect(document.paths["/v1/submissions"]?.post?.security).toHaveLength(2)
})

test("openapi leaves opaque SkillHub slug validation to the authoritative protocol", () => {
  const document = OpenApi.fromApi(SkillMarketApi)
  const command = document.components.schemas["SkillMarketControl.SkillHubImportCommandInput"] as {
    readonly anyOf: readonly [
      unknown,
      {
        readonly properties: {
          readonly slugs: { readonly items: unknown }
        }
      },
    ]
  }
  expect(command.anyOf[1].properties.slugs.items).toEqual({ type: "string" })
})

test("skillhub import progress decodes representative progress", () => {
  expect(
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportProgress)({
      state: "running",
      sourceStatus: "stale",
      upstreamTotal: 78_253,
      discovered: 10_000,
      pending: 7_000,
      running: 6,
      mirrored: 2_900,
      retryWait: 90,
      rejected: 4,
      uploadedBytes: 1_048_576,
      ratePerMinute: 120,
      estimatedSecondsRemaining: 37_676,
      lastPublishedAt: "2026-07-16T23:30:00.000Z",
      recentError: {
        code: "upstream",
        summary: "SkillHub page fetch timed out",
        occurredAt: "2026-07-17T00:00:00.000Z",
      },
      discoveryPage: 100,
      sweep: 1,
      metadataConcurrency: 8,
      packageConcurrency: 6,
      updatedAt: "2026-07-17T00:00:00.000Z",
    }),
  ).toMatchObject({
    mirrored: 2_900,
    lastPublishedAt: "2026-07-16T23:30:00.000Z",
    recentError: { code: "upstream" },
  })
  expect(() =>
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportProgress)({
      state: "failed",
      sourceStatus: "stale",
      upstreamTotal: 1,
      discovered: 1,
      pending: 0,
      running: 0,
      mirrored: 0,
      retryWait: 0,
      rejected: 1,
      uploadedBytes: 0,
      ratePerMinute: 0,
      recentError: {
        code: "validation",
        summary: "x".repeat(501),
        occurredAt: "2026-07-17T00:00:00.000Z",
      },
      discoveryPage: 1,
      sweep: 1,
      metadataConcurrency: 1,
      packageConcurrency: 1,
      updatedAt: "2026-07-17T00:00:00.000Z",
    }),
  ).toThrow()
})

test("skillhub evaluation progress decodes bounded counters and optional diagnostics", () => {
  expect(
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubEvaluationProgress)({
      total: 100,
      waiting: 1,
      pending: 50,
      running: 2,
      retryWait: 3,
      completed: 40,
      failed: 4,
      ratePerMinute: 60,
      estimatedSecondsRemaining: 55,
      recentError: "SkillHub evaluation timed out",
    }),
  ).toMatchObject({ completed: 40 })
  expect(() =>
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubEvaluationProgress)({
      total: 0,
      waiting: 0,
      pending: 0,
      running: 0,
      retryWait: 0,
      completed: 0,
      failed: 0,
      ratePerMinute: 0,
      recentError: "x".repeat(501),
    }),
  ).toThrow()
})

test("skillhub import commands decode bounded slug selections", () => {
  expect(
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportCommandInput)({ command: "pause" }).slugs,
  ).toBeUndefined()
  expect(
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportCommandInput)({
      command: "retry-rejected",
      slugs: ["技能审查", "owner/skill", "has whitespace", "control\u0080", "format\u200d"],
    }).slugs,
  ).toEqual(["技能审查", "owner/skill", "has whitespace", "control\u0080", "format\u200d"])
  expect(() =>
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportCommandInput)({
      command: "retry-rejected",
      slugs: Array.from({ length: 101 }, (_, index) => `skill-${index}`),
    }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportCommandInput)({
      command: "retry-rejected",
      slugs: ["a".repeat(257)],
    }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportCommandInput)({
      command: "retry-rejected",
      slugs: [""],
    }),
  ).toThrow()
  for (const command of ["pause", "resume", "retry-wait"] as const) {
    expect(() =>
      Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportCommandInput)({
        command,
        slugs: ["code-review"],
      }),
    ).toThrow()
  }
  expect(() =>
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportCommandInput)({ command: "retry-rejected" }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportCommandInput)({
      command: "retry-rejected",
      slugs: [],
    }),
  ).toThrow()
})

test("SkillHub slug validation exactly matches SQLite TEXT length semantics", () => {
  const database = new Database(":memory:")
  database.run("CREATE TABLE identifiers (slug TEXT PRIMARY KEY CHECK (length(slug) BETWEEN 1 AND 256)) STRICT")
  const cases = [
    { name: "200 emoji", value: "😀".repeat(200), accepted: true },
    { name: "NUL tail", value: `a\0${"x".repeat(300)}`, accepted: true },
    { name: "leading NUL", value: `\0${"x".repeat(300)}`, accepted: false },
    { name: "256 ASCII", value: "a".repeat(256), accepted: true },
    { name: "257 ASCII", value: "a".repeat(257), accepted: false },
    { name: "Unicode control", value: "control\u0080", accepted: true },
    { name: "Unicode format", value: "format\u200d", accepted: true },
  ] as const

  for (const sample of cases) {
    database.run("DELETE FROM identifiers")
    let databaseAccepted = true
    try {
      database.run("INSERT INTO identifiers (slug) VALUES (?)", [sample.value])
    } catch {
      databaseAccepted = false
    }
    expect(databaseAccepted, `${sample.name} database acceptance`).toBe(sample.accepted)
    expect(Schema.is(SkillMarketControl.SkillHubImportSlug)(sample.value), `${sample.name} schema acceptance`).toBe(
      sample.accepted,
    )
    if (sample.accepted) {
      expect(Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportSlug)(sample.value)).toBe(sample.value)
      expect(database.query<{ slug: string }, []>("SELECT slug FROM identifiers").get()?.slug).toBe(sample.value)
    }
  }
  database.close()
})
