import type { SkillMarket } from "@opencode-ai/schema/skill-market"

export function scoreLabel(record: SkillMarket.Summary) {
  if (record.evaluationScore !== undefined) return `${record.evaluationScore.toFixed(1)}/5`
  return record.source === "skillhub" ? "待评分" : "未评分"
}
