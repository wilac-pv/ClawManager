import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { SkillMarketPrincipal } from "@opencode-ai/protocol/skill-market-middleware"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { Favorites } from "../favorites"
import { principalFromSession } from "./middleware"

export function createFavoritesHttp(favorites: Favorites) {
  return HttpApiBuilder.group(SkillMarketApi, "skillMarket.favorites", (handlers) =>
    handlers
      .handle("skillMarket.favorites.list", () =>
        Effect.gen(function* () {
          return favorites.list(principalFromSession(yield* SkillMarketPrincipal))
        }),
      )
      .handle("skillMarket.favorites.add", (context) =>
        Effect.gen(function* () {
          return favorites.add(principalFromSession(yield* SkillMarketPrincipal), context.params)
        }),
      )
      .handle("skillMarket.favorites.remove", (context) =>
        Effect.gen(function* () {
          favorites.remove(principalFromSession(yield* SkillMarketPrincipal), context.params)
          return HttpServerResponse.empty()
        }),
      ),
  )
}
