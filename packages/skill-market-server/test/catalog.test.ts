import { describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { contentAddressDetail, createCatalogIndex, key, mergeCatalog, patchCatalogIndex, queryCatalog } from "../src/catalog"
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
      mergeCatalog([sampleDetail()], enterprise, {
        skillhub: "fresh",
        enterprise: "stale",
        community: "unavailable",
      }).revision,
    )
  })

  test("keeps catalog index revisions compatible with legacy whole-value serialization", () => {
    const entry = contentAddressDetail(sampleDetail())
    const entries = new Map([[key(entry.summary.source, entry.summary.id), entry]])
    const sourceStatus = { skillhub: "fresh", enterprise: "fresh", community: "unavailable" } as const

    const index = createCatalogIndex({ entries, sourceStatus })
    const legacyRevision = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify({ entries: Array.from(entries.entries()), sourceStatus }))
      .digest("hex")

    expect(index.revision).toBe(legacyRevision)
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

  test("keeps same-ID sources distinct and exposes community review metadata", () => {
    const community = sampleDetail({
      source: "community",
      sourceUrl: "https://market.example.com/skills/community/code-review",
      publicDetailUrl: "https://market.example.com/skills/community/code-review",
      name: "Community Code Review",
      submittedBy: { displayName: "CONTRIBUTOR" },
      reviewedAt: "2026-07-15T01:00:00.000Z",
      reviewRisk: "safe",
      risk: "safe",
      author: { name: "CONTRIBUTOR" },
    })
    const snapshot = mergeCatalog([sampleDetail(), community], enterprise, {
      skillhub: "fresh",
      enterprise: "fresh",
      community: "fresh",
    })

    expect(snapshot.details.size).toBe(2)
    expect(snapshot.facets.sources).toEqual([
      { value: "community", count: 1 },
      { value: "skillhub", count: 1 },
    ])
    expect(snapshot.items.find((item) => item.source === "community")).toMatchObject({
      submittedBy: { displayName: "CONTRIBUTOR" },
      reviewedAt: "2026-07-15T01:00:00.000Z",
      reviewRisk: "safe",
    })
  })

  test("rejects duplicate source and ID keys", () => {
    expect(() => mergeCatalog([sampleDetail(), sampleDetail()], enterprise)).toThrow("duplicate catalog key")
  })

  test("patches selected catalog entries without changing unrelated entries or revision compatibility", () => {
    const skillhub = contentAddressDetail(sampleDetail({ id: "a", name: "SkillHub A" }))
    const community = contentAddressDetail(
      sampleDetail({
        id: "community-a",
        source: "community",
        sourceUrl: "https://market.example.com/skills/community-a",
        publicDetailUrl: "https://market.example.com/skills/community-a",
        name: "Community A",
      }),
    )
    const index = createCatalogIndex({
      entries: new Map([
        [key(skillhub.summary.source, skillhub.summary.id), skillhub],
        [key(community.summary.source, community.summary.id), community],
      ]),
      sourceStatus: { skillhub: "stale", enterprise: "fresh", community: "fresh" },
      createdAt: "2026-07-21T00:00:00.000Z",
    })
    const replacement = contentAddressDetail(
      sampleDetail({ id: "a", name: "TRACE A", evaluationScore: 4.45, score: 0 }),
    )

    const patched = patchCatalogIndex({
      index,
      replacements: new Map([[key("skillhub", "a"), replacement]]),
      sourceStatus: { ...index.sourceStatus, skillhub: "fresh" },
      createdAt: "2026-07-22T00:00:00.000Z",
    })

    expect(patched.items.find((item) => item.id === "a")).toEqual(replacement.summary)
    expect(patched.details.get(key("skillhub", "a"))).toEqual(replacement.ref)
    expect(patched.items.find((item) => item.id === "community-a")).toEqual(
      index.items.find((item) => item.id === "community-a"),
    )
    expect(patched.details.get(key("community", "community-a"))).toEqual(
      index.details.get(key("community", "community-a")),
    )
    const entries = patched.items.map((summary) => [
      key(summary.source, summary.id),
      { summary, ref: patched.details.get(key(summary.source, summary.id))! },
    ])
    const legacyRevision = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify({ entries, sourceStatus: patched.sourceStatus }))
      .digest("hex")
    expect(patched.revision).toBe(legacyRevision)
    expect(patched.createdAt).toBe("2026-07-22T00:00:00.000Z")
  })

  test("rejects a patch replacement with an absent or mismatched key", () => {
    const entry = contentAddressDetail(sampleDetail({ id: "a" }))
    const index = createCatalogIndex({
      entries: new Map([[key(entry.summary.source, entry.summary.id), entry]]),
      sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "unavailable" },
    })
    const replacement = contentAddressDetail(sampleDetail({ id: "other" }))

    expect(() =>
      patchCatalogIndex({
        index,
        replacements: new Map([[key("skillhub", "missing"), entry]]),
        sourceStatus: index.sourceStatus,
      }),
    ).toThrow("missing catalog key")
    expect(() =>
      patchCatalogIndex({
        index,
        replacements: new Map([[key("skillhub", "a"), replacement]]),
        sourceStatus: index.sourceStatus,
      }),
    ).toThrow("replacement key mismatch")
  })
})
