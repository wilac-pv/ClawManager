import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { SkillMarketCatalogQuery } from "./skill-market-catalog"

const Key = { source: SkillMarket.PublicSource, id: Schema.String }

export class SkillMarketUnavailableError extends Schema.ErrorClass<SkillMarketUnavailableError>(
  "SkillMarketUnavailableError",
)(
  {
    name: Schema.Literal("SkillMarketUnavailableError"),
    code: Schema.Literals(["network-unavailable", "market-unavailable"]),
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export class SkillMarketConflictError extends Schema.ErrorClass<SkillMarketConflictError>("SkillMarketConflictError")(
  {
    name: Schema.Literal("SkillMarketConflictError"),
    code: Schema.Literals([
      "skill-delisted",
      "risk-confirmation-required",
      "hash-mismatch",
      "version-conflict",
      "not-market-owned",
    ]),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class SkillMarketOperationError extends Schema.ErrorClass<SkillMarketOperationError>(
  "SkillMarketOperationError",
)(
  {
    name: Schema.Literal("SkillMarketOperationError"),
    code: Schema.Literals(["unsafe-archive", "archive-limit", "invalid-skill", "disk-unavailable", "refresh-failed"]),
    message: Schema.String,
  },
  { httpApiStatus: 422 },
) {}

export const SkillMarketLocalError = Schema.Union([
  SkillMarketUnavailableError,
  SkillMarketConflictError,
  SkillMarketOperationError,
])
export type SkillMarketLocalError = typeof SkillMarketLocalError.Type
const SkillMarketLocalErrors = [
  SkillMarketUnavailableError,
  SkillMarketConflictError,
  SkillMarketOperationError,
] as const

export const SkillMarketLocalGroup = HttpApiGroup.make("server.skillMarket")
  .add(
    HttpApiEndpoint.get("skillMarket.list", "/api/skill/market/skills", {
      query: SkillMarketCatalogQuery,
      success: SkillMarket.Page,
      error: SkillMarketLocalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.facets", "/api/skill/market/facets", {
      success: SkillMarket.Facets,
      error: SkillMarketLocalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.detail", "/api/skill/market/skills/:source/:id", {
      params: Key,
      success: SkillMarket.Detail,
      error: SkillMarketLocalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.installed", "/api/skill/market/installed", {
      success: Schema.Array(SkillMarket.Installed),
      error: SkillMarketLocalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.updates", "/api/skill/market/updates", {
      success: Schema.Array(SkillMarket.Installed),
      error: SkillMarketLocalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.install", "/api/skill/market/install", {
      payload: SkillMarket.InstallRequest,
      success: SkillMarket.OperationResult,
      error: SkillMarketLocalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.update", "/api/skill/market/update", {
      payload: SkillMarket.InstallRequest,
      success: SkillMarket.OperationResult,
      error: SkillMarketLocalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("skillMarket.uninstall", "/api/skill/market/install/:source/:id", {
      params: Key,
      success: HttpApiSchema.NoContent,
      error: SkillMarketLocalErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.refresh", "/api/skill/market/install/:source/:id/refresh", {
      params: Key,
      success: HttpApiSchema.NoContent,
      error: SkillMarketLocalErrors,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Skill market",
      description: "Browse and manage Ruying Code Skills.",
    }),
  )
