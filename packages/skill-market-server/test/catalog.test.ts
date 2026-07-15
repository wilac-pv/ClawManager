import { describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { mergeCatalog, queryCatalog } from "../src/catalog"

const enterprise = Schema.decodeUnknownSync(SkillMarket.EnterpriseIndex)({
  schemaVersion: 1,
  updatedAt: "2026-07-15T00:00:00.000Z",
  skills: [
    {
      id: "code-review",
      source: "skillhub",
      referenceId: "code-review",
      featured: true,
      name: "企业 Code Review",
      description: "企业精选代码评审",
      category: "企业效率",
      version: "1.0.0",
      risk: "safe",
      riskReason: "企业精选",
      license: "MIT",
    },
  ],
})

describe("catalog", () => {
  test("applies enterprise display fields without reducing source risk", () => {
    const snapshot = mergeCatalog([sampleDetail()], enterprise)
    const item = snapshot.items[0]
    expect(item?.name).toBe("企业 Code Review")
    expect(item?.featured).toBe(true)
    expect(item?.enterprise).toBe(true)
    expect(item?.risk).toBe("warning")
    expect(snapshot.details.get("skillhub:code-review")?.license).toBe("MIT")
  })

  test("produces a deterministic revision independent of input order", () => {
    const first = sampleDetail()
    const second = sampleDetail({ id: "typescript-review", name: "TypeScript Review", score: 8 })
    expect(mergeCatalog([first, second], enterprise).revision).toBe(mergeCatalog([second, first], enterprise).revision)
  })

  test("filters, hides delisted skills, and returns summary DTOs", () => {
    const snapshot = mergeCatalog(
      [sampleDetail(), sampleDetail({ id: "hidden-review", name: "Hidden", delisted: true })],
      enterprise,
    )
    const page = queryCatalog(snapshot, {
      query: "企业",
      category: "企业效率",
      requiresApiKey: false,
      sort: "score",
      page: 1,
      limit: 30,
    })
    expect(page.total).toBe(1)
    expect(page.items[0]?.id).toBe("code-review")
    expect(page.items.every((item) => !Object.hasOwn(item, "readme"))).toBe(true)
  })
})

function sampleDetail(overrides: Partial<SkillMarket.Detail> = {}) {
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
