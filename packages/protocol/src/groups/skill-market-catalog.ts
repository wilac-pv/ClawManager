import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  SkillMarketControlNotFound,
  SkillMarketDependencyUnavailable,
  SkillMarketInvalidRequest,
} from "../skill-market-errors"
import {
  SkillMarketSessionMiddleware,
  SkillMarketWriteMiddleware,
  SkillMarketWriteOpenApi,
} from "../skill-market-middleware"

const Key = { source: SkillMarket.PublicSource, id: Schema.String }

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

const packageProblem = <Code extends string>(code: Code) => ({
  code: Schema.Literal(code),
  message: Schema.String,
  requestId: Schema.String,
  source: SkillMarket.Source,
  id: Schema.String,
})

export class SkillMarketPackageNotFound extends Schema.ErrorClass<SkillMarketPackageNotFound>(
  "SkillMarketPackageNotFound",
)(packageProblem("skill-market-not-found"), { httpApiStatus: 404 }) {}

export class SkillMarketPackageTooLarge extends Schema.ErrorClass<SkillMarketPackageTooLarge>(
  "SkillMarketPackageTooLarge",
)(packageProblem("skill-market-package-too-large"), { httpApiStatus: 413 }) {}

export class SkillMarketPackageUnavailable extends Schema.ErrorClass<SkillMarketPackageUnavailable>(
  "SkillMarketPackageUnavailable",
)(packageProblem("skill-market-package-unavailable"), { httpApiStatus: 502 }) {}

const PackageErrors = [SkillMarketPackageNotFound, SkillMarketPackageTooLarge, SkillMarketPackageUnavailable] as const

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
  .add(
    HttpApiEndpoint.get("skillMarket.catalog.package", "/v1/catalog/skills/:source/:id/package", {
      params: Key,
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: PackageErrors,
    }),
  )
  .add(
    HttpApiEndpoint.head("skillMarket.catalog.packageHead", "/v1/catalog/skills/:source/:id/package", {
      params: Key,
      success: HttpApiSchema.Empty(200),
      error: PackageErrors,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "Ruying Skill Market Catalog", description: "Read-only public catalog API." }),
  )

export const SkillMarketCatalogPrivateGroup = HttpApiGroup.make("skillMarket.catalogPrivate")
  .add(
    HttpApiEndpoint.get("skillMarket.catalog.restrictedDetail", "/v1/restricted-skills/:publicationID", {
      params: { publicationID: SkillMarketControl.PublicationID },
      success: SkillMarket.RestrictedDetail,
      error: [SkillMarketControlNotFound, SkillMarketDependencyUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.catalog.restrictedVersions", "/v1/restricted-skills/:publicationID/versions", {
      params: { publicationID: SkillMarketControl.PublicationID },
      success: Schema.Array(SkillMarket.Version),
      error: [SkillMarketControlNotFound, SkillMarketDependencyUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.catalog.privateInstallGrant", "/v1/restricted-skills/:publicationID/install-grants", {
      params: { publicationID: SkillMarketControl.PublicationID },
      success: SkillMarket.PrivateInstallGrant,
      error: [SkillMarketControlNotFound, SkillMarketInvalidRequest, SkillMarketDependencyUnavailable],
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketSessionMiddleware)
      .annotateMerge(SkillMarketWriteOpenApi),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "Ruying Restricted Skill Catalog", description: "Authorized private catalog." }),
  )
