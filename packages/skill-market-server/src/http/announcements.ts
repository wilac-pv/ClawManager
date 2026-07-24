import { SkillMarketAnnouncementNotFound } from "@opencode-ai/protocol/groups/skill-market-announcements"
import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { Announcements } from "../announcements"

export function createAnnouncementsHttp(announcements: Announcements) {
  return HttpApiBuilder.group(SkillMarketApi, "skillMarket.announcements", (handlers) =>
    handlers
      .handle("skillMarket.announcements.list", (context) =>
        Effect.sync(() =>
          announcements.list({
            page: context.query.page ?? 1,
            limit: context.query.limit ?? 20,
          }),
        ),
      )
      .handle("skillMarket.announcements.detail", (context) => {
        const detail = announcements.detail(context.params.announcementID)
        return detail
          ? Effect.succeed(detail)
          : Effect.fail(new SkillMarketAnnouncementNotFound({ announcementID: context.params.announcementID }))
      }),
  )
}
