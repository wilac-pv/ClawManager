import { HttpApi } from "effect/unstable/httpapi"
import { SkillMarketAdminGroup } from "./groups/skill-market-admin"
import { SkillMarketAnnouncementsGroup } from "./groups/skill-market-announcements"
import { SkillMarketAuthGroup } from "./groups/skill-market-auth"
import { SkillMarketCatalogGroup, SkillMarketCatalogPrivateGroup } from "./groups/skill-market-catalog"
import { SkillMarketExpertPackagesGroup } from "./groups/skill-market-expert-packages"
import { SkillMarketFavoritesGroup } from "./groups/skill-market-favorites"
import { SkillMarketGroupsGroup } from "./groups/skill-market-groups"
import { SkillMarketSubmissionSharingGroup, SkillMarketSubmissionsGroup } from "./groups/skill-market-submissions"

export const SkillMarketScopedSharingApi = HttpApi.make("skillMarketScopedSharing")
  .add(SkillMarketCatalogPrivateGroup)
  .add(SkillMarketGroupsGroup)
  .add(SkillMarketSubmissionSharingGroup)

export const SkillMarketCatalogApi = HttpApi.make("skillMarketCatalog")
  .add(SkillMarketCatalogGroup)
  .add(SkillMarketAnnouncementsGroup)
  .add(SkillMarketExpertPackagesGroup)

export const SkillMarketApi = HttpApi.make("skillMarket")
  .add(SkillMarketCatalogGroup)
  .add(SkillMarketAnnouncementsGroup)
  .add(SkillMarketExpertPackagesGroup)
  .add(SkillMarketFavoritesGroup)
  .add(SkillMarketGroupsGroup)
  .add(SkillMarketAuthGroup)
  .add(SkillMarketSubmissionsGroup)
  .add(SkillMarketSubmissionSharingGroup)
  .add(SkillMarketAdminGroup)
