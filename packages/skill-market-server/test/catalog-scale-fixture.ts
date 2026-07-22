import { type SkillMarket } from "@opencode-ai/schema/skill-market"
import { createCatalogIndex, key, patchCatalogIndex, type CatalogDetailRef } from "../src/catalog"

const started = performance.now()
const entries = new Map<string, { readonly summary: SkillMarket.Summary; readonly ref: CatalogDetailRef }>()

for (let index = 0; index < 80_000; index++) {
  const id = `skill-${index}`
  const summary: SkillMarket.Summary = {
    id,
    source: "skillhub",
    sourceUrl: `https://skillhub.example/${id}`,
    name: id,
    description: "TRACE scale fixture",
    categories: ["开发工具"],
    tags: ["trace"],
    requiresApiKey: false,
    risk: "safe",
    version: "1.0.0",
    updatedAt: "2026-07-22T00:00:00.000Z",
    downloads: index,
    favorites: 0,
    score: 100_000,
    featured: false,
    enterprise: false,
    delisted: false,
  }
  entries.set(key(summary.source, summary.id), {
    summary,
    ref: { key: `details/${id}.json`, sha256: "a".repeat(64), version: summary.version },
  })
}

const index = createCatalogIndex({
  entries,
  sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
})
const replacements = new Map(
  index.items.slice(0, 100).map((summary) => {
    const updated = { ...summary, score: 0, evaluationScore: 4.45 }
    return [key(updated.source, updated.id), { summary: updated, ref: index.details.get(key(updated.source, updated.id))! }] as const
  }),
)
const patched = patchCatalogIndex({
  index,
  replacements,
  sourceStatus: index.sourceStatus,
})
const maxRSS = process.resourceUsage().maxRSS

console.log(
  JSON.stringify({
    elapsedMilliseconds: performance.now() - started,
    maxRssKilobytes: process.platform === "darwin" ? maxRSS / 1024 : maxRSS,
    items: patched.items.length,
  }),
)
