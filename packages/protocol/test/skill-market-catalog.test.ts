import { expect, test } from "bun:test"
import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { normalizeSkillMarketCatalogQuery } from "../src/groups/skill-market-catalog"
import { SkillMarketLocalGroup } from "../src/groups/skill-market-local"
import { SkillMarketApi, SkillMarketCatalogApi } from "../src/skill-market-api"

test("catalog api contains package GET and HEAD operations", () => {
  const endpoints: Array<{ name: string; method: string; path: string }> = []
  HttpApi.reflect(SkillMarketCatalogApi, {
    onGroup() {},
    onEndpoint({ endpoint }) {
      endpoints.push({ name: endpoint.name, method: endpoint.method, path: endpoint.path })
    },
  })
  expect(endpoints.toSorted((left, right) => left.name.localeCompare(right.name))).toEqual([
    { name: "skillMarket.announcements.detail", method: "GET", path: "/v1/catalog/announcements/:announcementID" },
    { name: "skillMarket.announcements.list", method: "GET", path: "/v1/catalog/announcements" },
    { name: "skillMarket.catalog.detail", method: "GET", path: "/v1/catalog/skills/:source/:id" },
    { name: "skillMarket.catalog.download", method: "GET", path: "/v1/catalog/skills/:source/:id/download" },
    { name: "skillMarket.catalog.facets", method: "GET", path: "/v1/catalog/facets" },
    { name: "skillMarket.catalog.list", method: "GET", path: "/v1/catalog/skills" },
    { name: "skillMarket.catalog.package", method: "GET", path: "/v1/catalog/skills/:source/:id/package" },
    { name: "skillMarket.catalog.packageHead", method: "HEAD", path: "/v1/catalog/skills/:source/:id/package" },
    { name: "skillMarket.catalog.versions", method: "GET", path: "/v1/catalog/skills/:source/:id/versions" },
    { name: "skillMarket.expertPackages.detail", method: "GET", path: "/v1/catalog/expert-packages/:slug" },
    { name: "skillMarket.expertPackages.list", method: "GET", path: "/v1/catalog/expert-packages" },
  ])
})

test("full market api exposes authenticated favorite operations", () => {
  const endpoints: Array<{ name: string; method: string; path: string }> = []
  HttpApi.reflect(SkillMarketApi, {
    onGroup() {},
    onEndpoint({ endpoint }) {
      if (endpoint.name.startsWith("skillMarket.favorites."))
        endpoints.push({ name: endpoint.name, method: endpoint.method, path: endpoint.path })
    },
  })
  expect(endpoints).toEqual([
    { name: "skillMarket.favorites.list", method: "GET", path: "/v1/favorites" },
    { name: "skillMarket.favorites.add", method: "POST", path: "/v1/favorites/:source/:id" },
    { name: "skillMarket.favorites.remove", method: "DELETE", path: "/v1/favorites/:source/:id" },
  ])
})

test("package operations expose binary GET, empty HEAD, and package error statuses", () => {
  const document = OpenApi.fromApi(SkillMarketCatalogApi)
  const path = document.paths["/v1/catalog/skills/{source}/{id}/package"]

  expect(path?.get?.responses["200"]?.content).toEqual({
    "application/octet-stream": { schema: { type: "string", format: "binary" } },
  })
  expect(path?.head?.responses["200"]).toEqual({ description: "<No Content>" })
  expect(Object.keys(path?.get?.responses ?? {}).toSorted()).toEqual(["200", "404", "413", "502"])
  expect(Object.keys(path?.head?.responses ?? {}).toSorted()).toEqual(["200", "404", "413", "502"])
})

test("normalizes portable query strings into domain values", () => {
  expect(normalizeSkillMarketCatalogQuery({ requiresApiKey: "false", featured: "true", page: 2 })).toEqual({
    query: undefined,
    source: undefined,
    category: undefined,
    requiresApiKey: false,
    featured: true,
    enterprise: undefined,
    sort: "score",
    page: 2,
    limit: 30,
  })
})

test("local generic skill routes accept only public sources", () => {
  const document = OpenApi.fromApi(HttpApi.make("localSkillMarket").add(SkillMarketLocalGroup))
  const parameters = document.paths["/api/skill/market/skills/{source}/{id}"]?.get?.parameters
  expect(parameters?.find((parameter) => parameter.in === "path" && parameter.name === "source")?.schema).toEqual({
    type: "string",
    enum: ["skillhub", "enterprise", "community"],
  })
})
