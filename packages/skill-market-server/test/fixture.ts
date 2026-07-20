import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { key, mergeCatalog, queryCatalogIndex } from "../src/catalog"
import type { CatalogReader } from "../src/catalog-reader"

export function sampleDetail(overrides: Partial<SkillMarket.Detail> = {}) {
  return Schema.decodeUnknownSync(SkillMarket.Detail)({
    id: "code-review",
    source: "skillhub",
    sourceUrl: "https://clawhub.ai/wpank/code-review",
    name: "Code Review",
    description: "Review code",
    categories: ["开发工具"],
    tags: ["typescript", "review"],
    requiresApiKey: false,
    risk: "warning",
    version: "1.0.0",
    updatedAt: "2026-07-15T00:00:00.000Z",
    downloads: 20,
    favorites: 3,
    score: 9.5,
    featured: false,
    enterprise: false,
    delisted: false,
    readme: "# Code Review",
    author: { name: "wpank", url: "https://github.com/wpank" },
    versions: [
      {
        version: "1.0.0",
        publishedAt: "2026-07-15T00:00:00.000Z",
        sha256: "a".repeat(64),
        size: 2000,
      },
    ],
    securityReports: [],
    riskReason: "可疑，存在潜在风险",
    package: {
      url: "https://packages.example.com/code-review.zip",
      sha256: "a".repeat(64),
      size: 2000,
      files: [{ path: "SKILL.md", sha256: "b".repeat(64), size: 1200 }],
    },
    publicDetailUrl: "https://skillhub.cn/skills/code-review",
    ...overrides,
  })
}

export function sampleSnapshot(revision = "r1") {
  const snapshot = mergeCatalog(
    [sampleDetail()],
    Schema.decodeUnknownSync(SkillMarket.EnterpriseIndex)({
      schemaVersion: 1,
      updatedAt: "2026-07-15T00:00:00.000Z",
      skills: [],
    }),
  )
  return {
    ...snapshot,
    revision,
    createdAt: "2026-07-15T00:00:00.000Z",
    facets: { ...snapshot.facets, revision },
  }
}

export function sampleCatalogReader(snapshot: ReturnType<typeof sampleSnapshot>, failure?: () => never): CatalogReader {
  const index = async () => {
    failure?.()
    return {
      revision: snapshot.revision,
      createdAt: snapshot.createdAt,
      items: snapshot.items,
      details: new Map(),
      facets: snapshot.facets,
      sourceStatus: snapshot.sourceStatus,
    }
  }
  const detail = async (source: SkillMarket.Source, id: string) => {
    failure?.()
    return snapshot.details.get(key(source, id))
  }
  return {
    index,
    async list(query, current) {
      failure?.()
      return queryCatalogIndex(current ?? (await index()), query)
    },
    async facets(current) {
      failure?.()
      return (current ?? (await index())).facets
    },
    detail,
    async versions(source, id) {
      return (await detail(source, id))?.versions
    },
    async download(source, id) {
      const value = await detail(source, id)
      if (!value) return undefined
      return { url: value.package.url, sha256: value.package.sha256, size: value.package.size }
    },
  }
}
