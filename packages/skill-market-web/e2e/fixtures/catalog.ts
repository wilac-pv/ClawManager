import type { SkillMarket } from "@opencode-ai/schema/skill-market"

export const summary = {
  id: "code-review",
  source: "skillhub",
  sourceUrl: "https://skillhub.cn/skills/code-review",
  name: "Code Review",
  description: "审查代码并发现风险",
  iconUrl: "https://cdn.example.com/missing.png",
  categories: ["代码质量"],
  tags: ["review", "quality"],
  requiresApiKey: false,
  risk: "safe",
  version: "1.2.0",
  updatedAt: "2026-07-15T01:00:00.000Z",
  downloads: 1200,
  favorites: 80,
  score: 98.6,
  featured: true,
  enterprise: false,
  delisted: false,
} satisfies SkillMarket.Summary

export const version = {
  version: "1.2.0",
  publishedAt: "2026-07-15T01:00:00.000Z",
  sha256: "a".repeat(64),
  size: 2048,
} satisfies SkillMarket.Version

export const detail = {
  ...summary,
  readme: "# Code Review\n\n检查代码质量、潜在错误和维护风险。",
  license: "MIT",
  author: { name: "SkillHub Author", url: "https://example.com/author" },
  versions: [version],
  securityReports: [
    {
      provider: "Ruying Scanner",
      verdict: "safe",
      summary: "未发现已知恶意行为",
      reportUrl: "https://security.example.com/reports/code-review",
    },
  ],
  package: {
    url: "https://downloads.example.com/code-review.zip",
    sha256: "a".repeat(64),
    size: 2048,
    files: [{ path: "SKILL.md", sha256: "b".repeat(64), size: 1024 }],
  },
  publicDetailUrl: "https://market.example.com/skills/skillhub/code-review",
} satisfies SkillMarket.Detail

export const facets = {
  revision: "fixture-revision",
  sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
  sources: [
    { value: "skillhub", count: 1 },
    { value: "enterprise", count: 0 },
    { value: "community", count: 0 },
  ],
  categories: [{ value: "代码质量", count: 1 }],
  requiresApiKey: { yes: 0, no: 1 },
} satisfies SkillMarket.Facets
