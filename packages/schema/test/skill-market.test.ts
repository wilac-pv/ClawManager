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
    }
    const page = Schema.decodeUnknownSync(SkillMarket.Page)({
      revision: "r1",
      sourceStatus: { skillhub: "fresh", enterprise: "fresh" },
      total: 1,
      page: 1,
      limit: 30,
      items: [summary],
    })
    expect(page.items).toHaveLength(1)
    expect(() =>
      Schema.decodeUnknownSync(SkillMarket.Package)({
        url: "http://example.com/a.zip",
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
