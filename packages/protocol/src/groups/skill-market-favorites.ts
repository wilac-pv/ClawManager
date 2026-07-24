import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { SkillMarketSessionMiddleware, SkillMarketWriteMiddleware } from "../skill-market-middleware"

const Key = {
  source: SkillMarket.Source,
  id: SkillMarket.SkillKey.fields.id,
}

export const SkillMarketFavoritesGroup = HttpApiGroup.make("skillMarket.favorites")
  .add(
    HttpApiEndpoint.get("skillMarket.favorites.list", "/v1/favorites", {
      success: Schema.Array(SkillMarket.Favorite),
    }),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.favorites.add", "/v1/favorites/:source/:id", {
      params: Key,
      success: SkillMarket.Favorite,
    }).middleware(SkillMarketWriteMiddleware),
  )
  .add(
    HttpApiEndpoint.delete("skillMarket.favorites.remove", "/v1/favorites/:source/:id", {
      params: Key,
      success: HttpApiSchema.NoContent,
    }).middleware(SkillMarketWriteMiddleware),
  )
  .middleware(SkillMarketSessionMiddleware)
  .annotateMerge(
    OpenApi.annotations({
      title: "Ruying Skill Market Favorites",
      description: "Authenticated per-user Skill favorites.",
    }),
  )
