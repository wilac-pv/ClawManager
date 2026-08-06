import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { SkillMarketControlNotFound, SkillMarketDependencyUnavailable } from "@opencode-ai/protocol/skill-market-errors"
import { SkillMarketPrincipal } from "@opencode-ai/protocol/skill-market-middleware"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { Favorites } from "../favorites"
import { SkillMarketSecurityError } from "../security"
import { principalFromSession, requestID } from "./middleware"

export function createFavoritesHttp(favorites: Favorites) {
  return HttpApiBuilder.group(SkillMarketApi, "skillMarket.favorites", (handlers) =>
    handlers
      .handle("skillMarket.favorites.list", () =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({ try: () => favorites.list(principal), catch: dependencyProblem })
        }),
      )
      .handle("skillMarket.favorites.add", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({ try: () => favorites.add(principal, context.params), catch: favoriteProblem })
        }),
      )
      .handle("skillMarket.favorites.remove", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          yield* Effect.tryPromise({ try: () => favorites.remove(principal, context.params), catch: favoriteProblem })
          return HttpServerResponse.empty()
        }),
      ),
  )
}

function favoriteProblem(error: unknown) {
  if (error instanceof SkillMarketSecurityError && error.code === "not-found")
    return new SkillMarketControlNotFound({
      code: "not-found",
      message: "受限 Skill 不存在",
      requestId: requestID(),
    })
  return dependencyProblem()
}

function dependencyProblem() {
  return new SkillMarketDependencyUnavailable({
    code: "dependency-unavailable",
    message: "收藏服务暂不可用",
    requestId: requestID(),
  })
}
