import { expect, test } from "bun:test"
import { HttpApi } from "effect/unstable/httpapi"
import { normalizeSkillMarketCatalogQuery } from "../src/groups/skill-market-catalog"
import { SkillMarketCatalogApi } from "../src/skill-market-api"

test("catalog api contains package GET and HEAD operations", () => {
  const endpoints: Array<{ name: string; method: string }> = []
  HttpApi.reflect(SkillMarketCatalogApi, {
    onGroup() {},
    onEndpoint({ endpoint }) {
      endpoints.push({ name: endpoint.name, method: endpoint.method })
    },
  })
  expect(endpoints.toSorted((left, right) => left.name.localeCompare(right.name))).toEqual([
    { name: "skillMarket.catalog.detail", method: "GET" },
    { name: "skillMarket.catalog.download", method: "GET" },
    { name: "skillMarket.catalog.facets", method: "GET" },
    { name: "skillMarket.catalog.list", method: "GET" },
    { name: "skillMarket.catalog.package", method: "GET" },
    { name: "skillMarket.catalog.packageHead", method: "HEAD" },
    { name: "skillMarket.catalog.versions", method: "GET" },
  ])
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
