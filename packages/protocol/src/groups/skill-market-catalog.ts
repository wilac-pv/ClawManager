import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const Key = { source: SkillMarket.Source, id: Schema.String }

export const SkillMarketCatalogQuery = Schema.Struct({
  query: Schema.String.pipe(Schema.optional),
  source: SkillMarket.Source.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  requiresApiKey: Schema.Literals(["true", "false"]).pipe(Schema.optional),
  featured: Schema.Literals(["true", "false"]).pipe(Schema.optional),
  enterprise: Schema.Literals(["true", "false"]).pipe(Schema.optional),
  sort: SkillMarket.Sort.pipe(Schema.optional),
  page: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(100_000),
  ).pipe(Schema.optional),
  limit: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(100),
  ).pipe(Schema.optional),
})
export type SkillMarketCatalogQuery = typeof SkillMarketCatalogQuery.Type

export function normalizeSkillMarketCatalogQuery(query: SkillMarketCatalogQuery): SkillMarket.PageQuery {
  return {
    query: query.query,
    source: query.source,
    category: query.category,
    requiresApiKey: query.requiresApiKey === undefined ? undefined : query.requiresApiKey === "true",
    featured: query.featured === undefined ? undefined : query.featured === "true",
    enterprise: query.enterprise === undefined ? undefined : query.enterprise === "true",
    sort: query.sort ?? "score",
    page: query.page ?? 1,
    limit: query.limit ?? 30,
  }
}

export class SkillMarketNotFound extends Schema.ErrorClass<SkillMarketNotFound>("SkillMarketNotFound")(
  { source: SkillMarket.Source, id: Schema.String },
  { httpApiStatus: 404 },
) {}

export const SkillMarketCatalogGroup = HttpApiGroup.make("skillMarket.catalog")
  .add(
    HttpApiEndpoint.get("skillMarket.catalog.list", "/v1/catalog/skills", {
      query: SkillMarketCatalogQuery,
      success: SkillMarket.Page,
    }),
  )
  .add(HttpApiEndpoint.get("skillMarket.catalog.facets", "/v1/catalog/facets", { success: SkillMarket.Facets }))
  .add(
    HttpApiEndpoint.get("skillMarket.catalog.detail", "/v1/catalog/skills/:source/:id", {
      params: Key,
      success: SkillMarket.Detail,
      error: SkillMarketNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.catalog.versions", "/v1/catalog/skills/:source/:id/versions", {
      params: Key,
      success: Schema.Array(SkillMarket.Version),
      error: SkillMarketNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.catalog.download", "/v1/catalog/skills/:source/:id/download", {
      params: Key,
      success: SkillMarket.Download,
      error: SkillMarketNotFound,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "Ruying Skill Market Catalog", description: "Read-only public catalog API." }),
  )
