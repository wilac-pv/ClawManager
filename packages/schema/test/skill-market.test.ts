import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SkillMarket } from "../src/skill-market"

describe("SkillMarket", () => {
  test("decodes a catalog page and rejects an insecure package URL", () => {
    const summary = {
      id: "code-review",
      source: "skillhub",
      sourceUrl: "https://skillhub.cn/skills/code-review",
      name: "Code Review",
      description: "Review code",
      categories: ["Development"],
      tags: [],
      requiresApiKey: false,
      risk: "safe",
      version: "1.0.0",
      updatedAt: "2026-07-15T00:00:00.000Z",
      downloads: 20,
      favorites: 3,
      score: 9.5,
      featured: false,
      enterprise: false,
      delisted: false,
      aliases: ["code-review-slug"],
    }
    const page = Schema.decodeUnknownSync(SkillMarket.Page)({
      revision: "r1",
      sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
      total: 1,
      page: 1,
      limit: 30,
      items: [summary],
    })
    expect(page.items).toHaveLength(1)
    expect(Object.hasOwn(page.items[0], "aliases")).toBe(true)
    expect(() =>
      Schema.decodeUnknownSync(SkillMarket.Package)({
        url: "http://example.com/a.zip",
        sha256: "a".repeat(64),
        size: 1,
        files: [],
      }),
    ).toThrow()
  })

  test("accepts community as a public source", () => {
    expect(Schema.decodeUnknownSync(SkillMarket.Source)("community")).toBe("community")
  })

  test("accepts private HTTP market pages without relaxing remote assets", () => {
    const summary = {
      id: "private-review",
      source: "community",
      sourceUrl: "http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/skills/community/private-review",
      name: "Private Review",
      description: "Review code on the private network",
      categories: ["Development"],
      tags: ["review"],
      requiresApiKey: false,
      risk: "safe",
      version: "1.0.0",
      updatedAt: "2026-07-16T00:00:00.000Z",
      downloads: 0,
      favorites: 0,
      score: 0,
      featured: false,
      enterprise: false,
      delisted: false,
    }

    expect(
      Schema.decodeUnknownSync(SkillMarket.Page)({
        revision: "private-r1",
        sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
        total: 1,
        page: 1,
        limit: 30,
        items: [summary],
      }).items[0]?.sourceUrl,
    ).toBe(summary.sourceUrl)
    expect(
      Schema.decodeUnknownSync(SkillMarket.Detail)({
        ...summary,
        readme: "# Private Review\n",
        author: { name: "Contributor" },
        versions: [],
        securityReports: [],
        package: {
          url: "https://oss.example.com/private-review.zip",
          sha256: "a".repeat(64),
          size: 1,
          files: [],
        },
        publicDetailUrl: summary.sourceUrl,
      }).publicDetailUrl,
    ).toBe(summary.sourceUrl)
    expect(() =>
      Schema.decodeUnknownSync(SkillMarket.Summary)({ ...summary, sourceUrl: "http://example.com/skills/private-review" }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(SkillMarket.Summary)({
        ...summary,
        sourceUrl: "http://user:password@10.246.13.226/skills/private-review",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(SkillMarket.Package)({
        url: "http://10.0.0.1/private-review.zip",
        sha256: "a".repeat(64),
        size: 1,
        files: [],
      }),
    ).toThrow()
  })

  test("keeps domain query booleans and validates pagination", () => {
    const query = Schema.decodeUnknownSync(SkillMarket.PageQuery)({
      requiresApiKey: false,
      sort: "score",
      page: 1,
      limit: 30,
    })
    expect(query.requiresApiKey).toBe(false)
    expect(() => Schema.decodeUnknownSync(SkillMarket.PageQuery)({ sort: "score", page: 0, limit: 30 })).toThrow()
  })

  test("requires risk confirmation in install payload shape", () => {
    const value = Schema.decodeUnknownSync(SkillMarket.InstallRequest)({
      source: "enterprise",
      id: "safe-id",
      version: "1.0.0",
      sha256: "b".repeat(64),
      riskConfirmed: true,
    })
    expect(value.riskConfirmed).toBe(true)
  })
})
