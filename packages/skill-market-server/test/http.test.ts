import { describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { createCatalogHandler } from "../src/handlers"
import { sampleDetail, sampleSnapshot } from "./fixture"

describe("catalog HTTP", () => {
  test("serves all public operations from one loaded revision", async () => {
    const snapshot = sampleSnapshot("r1")
    let loads = 0
    const handler = createCatalogHandler(async () => {
      loads++
      return snapshot
    })

    const page = await handler(new Request("https://market.example.com/v1/catalog/skills?page=1&limit=30"))
    expect(page.status).toBe(200)
    expect(page.headers.get("x-skill-market-revision")).toBe("r1")
    expect(page.headers.get("access-control-allow-origin")).toBe("*")
    expect(page.headers.has("access-control-allow-credentials")).toBe(false)
    expect(Schema.decodeUnknownSync(SkillMarket.Page)(await page.json()).items).toHaveLength(1)

    const detail = await handler(new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review"))
    expect(detail.status).toBe(200)
    expect(Schema.decodeUnknownSync(SkillMarket.Detail)(await detail.json()).id).toBe("code-review")

    const versions = await handler(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/versions"),
    )
    expect(Schema.decodeUnknownSync(Schema.Array(SkillMarket.Version))(await versions.json())[0]?.version).toBe("1.0.0")

    const download = await handler(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/download"),
    )
    expect(await download.json()).toEqual({
      url: "https://packages.example.com/code-review.zip",
      sha256: "a".repeat(64),
      size: 2000,
    })
    expect(loads).toBe(4)
  })

  test("handles preflight without loading the catalog and rejects invalid queries", async () => {
    let loads = 0
    const handler = createCatalogHandler(async () => {
      loads++
      return sampleSnapshot("r1")
    })
    const preflight = await handler(new Request("https://market.example.com/v1/catalog/skills", { method: "OPTIONS" }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS")
    expect(loads).toBe(0)

    const invalid = await handler(new Request("https://market.example.com/v1/catalog/skills?page=0"))
    expect(invalid.status).toBe(400)
    expect(loads).toBe(1)
  })

  test("does not expose delisted details", async () => {
    const snapshot = sampleSnapshot("r1")
    snapshot.details.set("skillhub:code-review", sampleDetail({ delisted: true }))
    const response = await createCatalogHandler(async () => snapshot)(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review"),
    )
    expect(response.status).toBe(404)
  })
})
