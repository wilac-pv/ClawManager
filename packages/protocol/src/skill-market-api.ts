import { HttpApi } from "effect/unstable/httpapi"
import { SkillMarketCatalogGroup } from "./groups/skill-market-catalog"

export const SkillMarketCatalogApi = HttpApi.make("skillMarketCatalog").add(SkillMarketCatalogGroup)
