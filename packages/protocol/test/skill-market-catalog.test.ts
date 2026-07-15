import { expect, test } from "bun:test"
import { HttpApi } from "effect/unstable/httpapi"
import { normalizeSkillMarketCatalogQuery } from "../src/groups/skill-market-catalog"
import { SkillMarketCatalogApi } from "../src/skill-market-api"

test("catalog api contains five public operations", () => {
  const endpoints: string[] = []
  HttpApi.reflect(SkillMarketCatalogApi, {
    onGroup() {},
    onEndpoint({ endpoint }) {
      endpoints.push(endpoint.name)
    },
  })
  expect(endpoints.toSorted()).toEqual([
    "skillMarket.catalog.detail",
    "skillMarket.catalog.download",
    "skillMarket.catalog.facets",
    "skillMarket.catalog.list",
    "skillMarket.catalog.versions",
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
