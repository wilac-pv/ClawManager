import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const PageNumber = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100_000),
)
const PageLimit = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100),
)

export class SkillMarketAnnouncementNotFound extends Schema.ErrorClass<SkillMarketAnnouncementNotFound>(
  "SkillMarketAnnouncementNotFound",
)(
  { announcementID: SkillMarket.AnnouncementID },
  { httpApiStatus: 404 },
) {}

export const SkillMarketAnnouncementsGroup = HttpApiGroup.make("skillMarket.announcements")
  .add(
    HttpApiEndpoint.get("skillMarket.announcements.list", "/v1/catalog/announcements", {
      query: Schema.Struct({
        page: PageNumber.pipe(Schema.optional),
        limit: PageLimit.pipe(Schema.optional),
      }),
      success: SkillMarket.AnnouncementPage,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.announcements.detail", "/v1/catalog/announcements/:announcementID", {
      params: { announcementID: SkillMarket.AnnouncementID },
      success: SkillMarket.AnnouncementDetail,
      error: SkillMarketAnnouncementNotFound,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Ruying Skill Market Announcements",
      description: "Published market announcements and history.",
    }),
  )
