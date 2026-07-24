import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { SkillMarketExpertPackageNotFound } from "@opencode-ai/protocol/groups/skill-market-expert-packages"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { ExpertPackages } from "../expert-packages"

export function createExpertPackagesHttp(expertPackages: ExpertPackages) {
  return HttpApiBuilder.group(SkillMarketApi, "skillMarket.expertPackages", (handlers) =>
    handlers
      .handle("skillMarket.expertPackages.list", (context) =>
        Effect.sync(() =>
          expertPackages.list({
            query: context.query.query,
            scene: context.query.scene,
            page: context.query.page ?? 1,
            limit: context.query.limit ?? 30,
          }),
        ),
      )
      .handle("skillMarket.expertPackages.detail", (context) => {
        const detail = expertPackages.detail(context.params.slug)
        return detail
          ? Effect.succeed(detail)
          : Effect.fail(new SkillMarketExpertPackageNotFound({ slug: context.params.slug }))
      }),
  )
}
