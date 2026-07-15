import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { mergeCatalog } from "../src/catalog"

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
