import { expect, test } from "bun:test"
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
