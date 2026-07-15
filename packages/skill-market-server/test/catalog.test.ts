import { describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { mergeCatalog, queryCatalog } from "../src/catalog"
import { sampleDetail } from "./fixture"

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

  test("applies enterprise references through a verified source alias", () => {
    const snapshot = mergeCatalog([sampleDetail({ id: "verified-review", aliases: ["code-review"] })], enterprise)
    expect(snapshot.items[0]?.name).toBe("企业 Code Review")
    expect(snapshot.items[0]?.enterprise).toBe(true)
  })

  test("produces a deterministic revision independent of input order", () => {
    const first = sampleDetail()
    const second = sampleDetail({ id: "typescript-review", name: "TypeScript Review", score: 8 })
    expect(mergeCatalog([first, second], enterprise).revision).toBe(mergeCatalog([second, first], enterprise).revision)
  })

  test("changes revision when immutable detail content changes", () => {
    expect(mergeCatalog([sampleDetail()], enterprise).revision).not.toBe(
      mergeCatalog([sampleDetail({ readme: "# Updated Code Review" })], enterprise).revision,
    )
  })

  test("changes revision when source status changes", () => {
    expect(mergeCatalog([sampleDetail()], enterprise).revision).not.toBe(
      mergeCatalog([sampleDetail()], enterprise, { skillhub: "fresh", enterprise: "stale" }).revision,
    )
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
