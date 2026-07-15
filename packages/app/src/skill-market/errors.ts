import { MarketLocalError, type MarketLocalErrorCode } from "./desktop-source"

export type SkillMarketErrorKey = `skillMarket.error.${MarketLocalErrorCode}`

export function skillMarketErrorKey(code: MarketLocalErrorCode): SkillMarketErrorKey {
  return `skillMarket.error.${code}`
}

export function skillMarketErrorMessage(error: unknown, translate: (key: SkillMarketErrorKey) => string) {
  if (error instanceof MarketLocalError) return translate(skillMarketErrorKey(error.code))
  return translate(skillMarketErrorKey("market-unavailable"))
}
