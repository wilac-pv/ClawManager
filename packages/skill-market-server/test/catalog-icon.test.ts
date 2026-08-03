import { expect, test } from "bun:test"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { createCatalogIconProxy } from "../src/catalog-icon"

const body = new TextEncoder().encode("icon")
const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
const sourceUrl = `https://oss.example.com/market/icons/${sha256}.png`

const summary = {
  id: "code-review",
  source: "skillhub",
  sourceUrl: "https://skillhub.cn/skills/code-review",
  name: "Code Review",
  description: "Review code",
  iconUrl: sourceUrl,
  categories: [],
  tags: [],
  requiresApiKey: false,
  risk: "safe",
  version: "1.0.0",
  updatedAt: "2026-08-03T00:00:00.000Z",
  downloads: 1,
  favorites: 0,
  score: 1,
  featured: false,
  enterprise: false,
  delisted: false,
} satisfies SkillMarket.Summary

test("verifies and serves only mirrored immutable icon objects", async () => {
  const reads: string[] = []
  const proxy = createCatalogIconProxy({
    store: {
      put: async () => undefined,
      head: async (key) => {
        reads.push(key)
        return { size: body.byteLength }
      },
      get: async (key) => {
        reads.push(key)
        return body
      },
    },
    publicPrefix: "skill-market",
    publicBaseUrl: "https://oss.example.com/market/",
  })

  expect(await proxy.read(summary.iconUrl!)).toEqual({ body, contentType: "image/png", sha256 })
  expect(reads).toEqual([`skill-market/icons/${sha256}.png`, `skill-market/icons/${sha256}.png`])
  expect(await proxy.read("https://untrusted.example.com/icons/" + sha256 + ".png")).toBeUndefined()
})
