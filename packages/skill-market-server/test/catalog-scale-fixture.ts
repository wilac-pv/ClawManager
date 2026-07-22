import { type SkillMarket } from "@opencode-ai/schema/skill-market"
import { createCatalogIndex, key, type CatalogDetailRef } from "../src/catalog"
import { catalogIndexPayload, prepareCatalogDelta, type ObjectStore } from "../src/oss"

const started = performance.now()
const entries = new Map<string, { readonly summary: SkillMarket.Summary; readonly ref: CatalogDetailRef }>()
const descriptions = [
  "面向工程协作的可审计自动化步骤，帮助代码、文档和发布工作保持一致。",
  "提供结构化检查、风险提示与复用模板，减少切换上下文时遗漏关键细节。",
  "根据项目约定生成清晰建议，保留输入、输出和验证结果用于后续复盘。",
  "覆盖分析、实现、测试和交付环节的可配置工作流，适合团队日常复用。",
]
const categories = [["开发工具", "代码质量"], ["效率工具"], ["项目管理", "文档"], ["数据分析"]] as const
const tags = [["typescript", "review", "automation"], ["workflow", "team"], ["testing", "quality"], ["documentation", "productivity"]] as const

for (let index = 0; index < 80_000; index++) {
  const id = `skill-${index}`
  const category = categories[index % categories.length]!
  const skillTags = tags[index % tags.length]!
  const description = `${descriptions[index % descriptions.length]!} 当前条目为 ${id}，适用分类：${category.join("、")}；标签：${skillTags.join("、")}。`
    .padEnd(100 + (index % 40), ".")
  const sha256 = index.toString(16).padStart(64, "0")
  const summary: SkillMarket.Summary = {
    id,
    source: "skillhub",
    sourceUrl: `https://skillhub.example/${id}`,
    name: `TRACE ${index} 工程协作助手`,
    description,
    iconUrl: index % 5 === 0 ? `https://skillhub.example/icons/${index % 200}.png` : undefined,
    categories: [...category],
    tags: [...skillTags],
    aliases: index % 4 === 0 ? [`trace-${index}`, `工程协作-${index}`] : undefined,
    requiresApiKey: index % 7 === 0,
    risk: index % 23 === 0 ? "warning" : "safe",
    version: `${1 + (index % 4)}.${index % 10}.${index % 20}`,
    updatedAt: "2026-07-22T00:00:00.000Z",
    downloads: index,
    favorites: index % 100,
    score: 100_000,
    evaluationScore: index % 5 === 0 ? 4 + (index % 10) / 20 : undefined,
    featured: index % 29 === 0,
    enterprise: index % 41 === 0,
    delisted: index % 101 === 0,
  }
  entries.set(key(summary.source, summary.id), {
    summary,
    ref: { key: `details/${sha256}.json`, sha256, version: summary.version },
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
const sourceBytes = await collectCatalogPayload(index)
const objects = new Map([
  ["skill-market/current.json", new TextEncoder().encode(JSON.stringify({ revision: index.revision, createdAt: index.createdAt }))],
  [`skill-market/indexes/${index.revision}/catalog.json`, sourceBytes],
  [`skill-market/indexes/${index.revision}/facets.json`, new TextEncoder().encode(JSON.stringify(index.facets))],
])
const store: ObjectStore = {
  async put() {},
  async get(objectKey) {
    const body = objects.get(objectKey)
    if (!body) throw new Error(`missing ${objectKey}`)
    return body
  },
  async head(objectKey) {
    const body = objects.get(objectKey)
    if (!body) throw new Error(`missing ${objectKey}`)
    return { size: body.byteLength }
  },
}
const itemCount = index.items.length
const deltaReplacements = new Map(
  Array.from(replacements, ([entryKey, replacement]) => [
    entryKey,
    { ...replacement, expectedSha256: index.details.get(entryKey)!.sha256 },
  ]),
)
entries.clear()
replacements.clear()
index.items.splice(0)
if (index.details instanceof Map) index.details.clear()
Bun.gc(true)
const delta = await prepareCatalogDelta(
  store,
  { prefix: "skill-market" },
  deltaReplacements,
  {},
)
let streamedBytes = 0
let streamedChunks = 0
for await (const chunk of delta.body()) {
  streamedBytes += chunk.byteLength
  streamedChunks++
}
const maxRSS = process.resourceUsage().maxRSS

console.log(
  JSON.stringify({
    elapsedMilliseconds: performance.now() - started,
    maxRssKilobytes: process.platform === "darwin" ? maxRSS / 1024 : maxRSS,
    items: itemCount,
    catalogPayloadBytes: delta.contentLength,
    streamedBytes,
    streamedChunks,
  }),
)

async function collectCatalogPayload(index: Parameters<typeof catalogIndexPayload>[0]) {
  const payload = catalogIndexPayload(index)
  const body = new Uint8Array(payload.contentLength)
  let offset = 0
  for await (const chunk of payload.body()) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}
