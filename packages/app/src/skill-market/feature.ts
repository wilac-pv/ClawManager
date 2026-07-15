export function isSkillMarketEnabled(value = import.meta.env.VITE_RUYING_SKILL_MARKET_ENABLED) {
  return value !== "false"
}

export const skillMarketEnabled = isSkillMarketEnabled()
