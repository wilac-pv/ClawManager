import "./styles.css"

export { installPrompt, SkillMarketDetail } from "./detail"
export {
  createDesktopSkillMarket,
  MarketLocalError,
  marketLocalErrorCodes,
  type MarketLocalErrorCode,
} from "./desktop-source"
export { DesktopInstalledActions, DesktopSkillActions, desktopActionState } from "./desktop-actions"
export { DesktopSkillMarketProvider, useDesktopSkillMarket } from "./desktop-provider"
export { skillMarketErrorKey, skillMarketErrorMessage, type SkillMarketErrorKey } from "./errors"
export { SkillMarketList } from "./list"
export { MarketMarkdown } from "./markdown"
export { SkillMarketProvider, useSkillMarket } from "./provider"
export type { SkillKey, SkillMarketActions, SkillMarketDataSource } from "./types"
