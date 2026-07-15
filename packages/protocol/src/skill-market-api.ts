import { HttpApi } from "effect/unstable/httpapi"
import { SkillMarketAdminGroup } from "./groups/skill-market-admin"
import { SkillMarketAuthGroup } from "./groups/skill-market-auth"
import { SkillMarketCatalogGroup } from "./groups/skill-market-catalog"
import { SkillMarketSubmissionsGroup } from "./groups/skill-market-submissions"

export const SkillMarketCatalogApi = HttpApi.make("skillMarketCatalog").add(SkillMarketCatalogGroup)

export const SkillMarketApi = HttpApi.make("skillMarket")
  .add(SkillMarketCatalogGroup)
  .add(SkillMarketAuthGroup)
  .add(SkillMarketSubmissionsGroup)
  .add(SkillMarketAdminGroup)
