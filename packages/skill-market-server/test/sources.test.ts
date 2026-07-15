import { describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { loadConfig } from "../src/config"
import { loadEnterprise } from "../src/enterprise"
import { loadSkillHub } from "../src/skillhub"

const fixtures = new URL("../fixtures/", import.meta.url)

describe("catalog sources", () => {
  test("normalizes SkillHub metadata without fabricating verified package fields", async () => {
    const calls: string[] = []
    const records = await loadSkillHub(async (input) => {
      const url = requestUrl(input)
      calls.push(url)
      const file = url.includes("/api/skills?")
        ? "skillhub-page.json"
        : url.includes("/files?")
          ? "skillhub-files.json"
          : url.endsWith("/versions")
            ? "skillhub-versions.json"
            : "skillhub-detail.json"
      return new Response(Bun.file(new URL(file, fixtures)), { headers: { "content-type": "application/json" } })
    }, "https://api.skillhub.cn")

    expect(records).toHaveLength(1)
    expect(records[0]?.risk).toBe("warning")
    expect(records[0]?.files[0]?.path).toBe("SKILL.md")
    expect(records[0]?.downloadUrl).toBe("https://api.skillhub.cn/api/v1/download?slug=code-review&version=1.0.0")
    expect(calls).toHaveLength(4)

    const reused = await loadSkillHub(
      async (input) => {
        const url = requestUrl(input)
        if (!url.includes("/api/skills?")) throw new Error(`unexpected refresh ${url}`)
        return new Response(Bun.file(new URL("skillhub-page.json", fixtures)), {
          headers: { "content-type": "application/json" },
        })
      },
      "https://api.skillhub.cn",
      new Map(records.map((record) => [record.slug, record])),
    )
    expect(reused[0]).toBe(records[0])
  })

  test("decodes enterprise metadata and rejects unapproved package hosts", async () => {
    const fetcher = async () =>
      new Response(Bun.file(new URL("enterprise-index.json", fixtures)), {
        headers: { "content-type": "application/json" },
      })
    const enterprise = await loadEnterprise(
      fetcher,
      "https://oss.example.com/enterprise-index.json",
      new Set(["oss.example.com"]),
    )
    expect(enterprise.skills).toHaveLength(2)
    await expect(
      loadEnterprise(fetcher, "https://oss.example.com/enterprise-index.json", new Set(["other.example.com"])),
    ).rejects.toThrow("not allowed")
  })

  test("validates required HTTPS configuration", () => {
    expect(() =>
      loadConfig({
        SKILL_MARKET_ENTERPRISE_INDEX_URL: "http://oss.example.com/enterprise.json",
        SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
        SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com",
      }),
    ).toThrow("SKILL_MARKET_ENTERPRISE_INDEX_URL must be an HTTPS URL")
    const config = loadConfig({
      SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
      SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
      SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com",
    })
    expect(config.port).toBe(4210)
    expect(config.skillhubBaseUrl).toBe("https://skillhub.cn/")
    expect(config.allowedHosts).toEqual(new Set(["skillhub.cn"]))
  })

  test("enterprise fixture satisfies the public schema", async () => {
    const value = await Bun.file(new URL("enterprise-index.json", fixtures)).json()
    expect(Schema.decodeUnknownSync(SkillMarket.EnterpriseIndex)(value).schemaVersion).toBe(1)
  })
})

function requestUrl(input: string | URL | Request) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}
