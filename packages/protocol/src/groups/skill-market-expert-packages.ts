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

export class SkillMarketExpertPackageNotFound extends Schema.ErrorClass<SkillMarketExpertPackageNotFound>(
  "SkillMarketExpertPackageNotFound",
)(
  { slug: SkillMarket.ExpertPackageSummary.fields.slug },
  { httpApiStatus: 404 },
) {}

export const SkillMarketExpertPackagesGroup = HttpApiGroup.make("skillMarket.expertPackages")
  .add(
    HttpApiEndpoint.get("skillMarket.expertPackages.list", "/v1/catalog/expert-packages", {
      query: Schema.Struct({
        query: Schema.String.pipe(Schema.optional),
        scene: SkillMarket.ExpertPackageScene.pipe(Schema.optional),
        page: PageNumber.pipe(Schema.optional),
        limit: PageLimit.pipe(Schema.optional),
      }),
      success: SkillMarket.ExpertPackagePage,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.expertPackages.detail", "/v1/catalog/expert-packages/:slug", {
      params: { slug: SkillMarket.ExpertPackageSummary.fields.slug },
      success: SkillMarket.ExpertPackageDetail,
      error: SkillMarketExpertPackageNotFound,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Ruying Skill Market Expert Packages",
      description: "Locally synchronized expert workflow packages.",
    }),
  )
