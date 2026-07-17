import { expect, test } from "bun:test"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { SkillMarketApi, SkillMarketCatalogApi } from "../src/skill-market-api"

const expected = [
  ["skillMarket.auth.login", "GET", "/v1/auth/login"],
  ["skillMarket.auth.callback", "GET", "/v1/auth/callback/:attemptID"],
  ["skillMarket.auth.session", "GET", "/v1/auth/session"],
  ["skillMarket.auth.logout", "DELETE", "/v1/auth/session"],
  ["skillMarket.submissions.list", "GET", "/v1/submissions"],
  ["skillMarket.submissions.create", "POST", "/v1/submissions"],
  ["skillMarket.submissions.detail", "GET", "/v1/submissions/:submissionID"],
  ["skillMarket.submissions.revise", "POST", "/v1/submissions/:submissionID/revisions"],
  ["skillMarket.admin.submissions.list", "GET", "/v1/admin/submissions"],
  ["skillMarket.admin.submissions.detail", "GET", "/v1/admin/submissions/:submissionID"],
  ["skillMarket.admin.submissions.decision", "POST", "/v1/admin/submissions/:submissionID/decision"],
  ["skillMarket.admin.submissions.retry", "POST", "/v1/admin/submissions/:submissionID/retry-publish"],
  ["skillMarket.admin.skillhub.status", "GET", "/v1/admin/skillhub-import"],
  ["skillMarket.admin.skillhub.command", "POST", "/v1/admin/skillhub-import/command"],
  ["skillMarket.admin.roles.list", "GET", "/v1/admin/roles"],
  ["skillMarket.admin.roles.create", "POST", "/v1/admin/roles"],
  ["skillMarket.admin.roles.delete", "DELETE", "/v1/admin/roles/:employeeID/:role"],
  ["skillMarket.admin.audit.list", "GET", "/v1/admin/audit"],
  ["skillMarket.admin.community.delist", "POST", "/v1/admin/community-skills/:skillID/delist"],
  ["skillMarket.admin.community.restore", "POST", "/v1/admin/community-skills/:skillID/restore"],
] as const

test("full market api declares every auth, submission, and admin operation", () => {
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
  expect(document.paths["/v1/submissions"]?.get?.security).toHaveLength(1)
  expect(document.paths["/v1/submissions"]?.post?.security).toHaveLength(2)
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
