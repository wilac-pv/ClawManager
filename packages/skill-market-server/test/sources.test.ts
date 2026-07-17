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
    const records = await loadSkillHub(
      async (input) => {
        const url = requestUrl(input)
        calls.push(url)
        if (url.includes("/api/skills?")) {
          const page = await Bun.file(new URL("skillhub-page.json", fixtures)).json()
          page.data.total = 101
          return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } })
        }
        const file = url.includes("/files?")
          ? "skillhub-files.json"
          : url.endsWith("/versions")
            ? "skillhub-versions.json"
            : "skillhub-detail.json"
        return new Response(Bun.file(new URL(file, fixtures)), { headers: { "content-type": "application/json" } })
      },
      "https://api.skillhub.cn",
      undefined,
      1,
    )

    expect(records).toHaveLength(1)
    expect(records[0]?.risk).toBe("warning")
    expect(records[0]?.requiresApiKey).toBe(false)
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
    const error = await loadEnterprise(
      fetcher,
      "https://oss.example.com/enterprise-index.json",
      new Set(["other.example.com"]),
    ).then(() => "", String)
    expect(error).toContain("not allowed")
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
    expect(config.skillhubBaseUrl).toBe("https://api.skillhub.cn/")
    expect(config.skillhubPageConcurrency).toBe(4)
    expect(config.skillhubMetadataConcurrency).toBe(8)
    expect(config.skillhubPackageConcurrency).toBe(6)
    expect(config.skillhubPublishBatch).toBe(2_000)
    expect(config.skillhubPublishMinutes).toBe(30)
    expect(config.skillhubMemorySoftLimitMb).toBe(1_536)
    expect(config.allowedHosts).toEqual(new Set(["api.skillhub.cn"]))
    expect(() =>
      loadConfig({
        SKILL_MARKET_SKILLHUB_LIMIT: "0",
        SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
        SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
        SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com",
      }),
    ).toThrow("SKILL_MARKET_SKILLHUB_LIMIT must be a positive integer")
    expect(() =>
      loadConfig({
        SKILL_MARKET_SKILLHUB_PAGE_CONCURRENCY: "17",
        SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
        SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
        SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com",
      }),
    ).toThrow("SKILL_MARKET_SKILLHUB_PAGE_CONCURRENCY")
    expect(() =>
      loadConfig({
        SKILL_MARKET_SKILLHUB_MEMORY_SOFT_LIMIT_MB: "511",
        SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
        SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
        SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com",
      }),
    ).toThrow("SKILL_MARKET_SKILLHUB_MEMORY_SOFT_LIMIT_MB")
  })

  test("normalizes control-plane configuration and applies safe defaults", () => {
    const config = loadConfig({
      SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
      SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
      SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com",
      SKILL_MARKET_OSS_PREFIX: "/ai-coding/ruying-code/skill-market/",
      SKILL_MARKET_PRIVATE_OSS_PREFIX: "/ai-coding/ruying-code/skill-market-private/",
      SKILL_MARKET_BOOTSTRAP_ADMIN_EMPLOYEE_IDS: " E000001,E000002,E000001 ",
    })

    expect(config.databasePath).toBe("/var/lib/ruying-skill-market/market.db")
    expect(config.migrationBackupDirectory).toBe("/var/backups/ruying-skill-market/migrations")
    expect(config.ossPrefix).toBe("ai-coding/ruying-code/skill-market")
    expect(config.privateOssPrefix).toBe("ai-coding/ruying-code/skill-market-private")
    expect(config.webOrigin).toBe("http://127.0.0.1:4211")
    expect(config.apiPublicUrl).toBe("http://127.0.0.1:4210/")
    expect(config.cookieSecure).toBe(false)
    expect(config.sessionIdleMilliseconds).toBe(2 * 60 * 60 * 1_000)
    expect(config.sessionAbsoluteMilliseconds).toBe(12 * 60 * 60 * 1_000)
    expect(config.sessionCookieMaxAgeSeconds).toBe(12 * 60 * 60)
    expect(config.dailyUploadLimit).toBe(20)
    expect(config.activeSubmissionLimit).toBe(5)
    expect(config.bootstrapAdmins).toEqual(["E000001", "E000002"])
  })

  test("rejects overlapping public and private OSS prefixes", () => {
    expect(() =>
      loadConfig({
        SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
        SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
        SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com",
        SKILL_MARKET_OSS_PREFIX: "skill-market",
        SKILL_MARKET_PRIVATE_OSS_PREFIX: "skill-market/private",
      }),
    ).toThrow("SKILL_MARKET_PRIVATE_OSS_PREFIX must not overlap SKILL_MARKET_OSS_PREFIX")
  })

  test("allows insecure cookies only for explicit private-IP testing", () => {
    const base = {
      SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
      SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
      SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com",
      SKILL_MARKET_WEB_ORIGIN: "http://10.246.13.226:4211",
      SKILL_MARKET_WEB_BASE_PATH: "/ai-coding/ruying-code/skill-market",
      SKILL_MARKET_API_PUBLIC_URL: "http://10.246.13.226:4210",
    }
    expect(() => loadConfig(base)).toThrow("SKILL_MARKET_ALLOW_INSECURE_IP_HTTP=true")

    const config = loadConfig({ ...base, SKILL_MARKET_ALLOW_INSECURE_IP_HTTP: "true" })
    expect(config.cookieSecure).toBe(false)
    expect(config.webOrigin).toBe("http://10.246.13.226:4211")
    expect(config.webBasePath).toBe("/ai-coding/ruying-code/skill-market/")
    expect(config.webBaseUrl).toBe("http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/")

    ;["relative/path", "/safe/../admin", "/safe?query=1", "/safe#fragment", "/safe\\admin"].forEach(
      (webBasePath) =>
        expect(() =>
          loadConfig({
            ...base,
            SKILL_MARKET_WEB_BASE_PATH: webBasePath,
            SKILL_MARKET_ALLOW_INSECURE_IP_HTTP: "true",
          }),
        ).toThrow("SKILL_MARKET_WEB_BASE_PATH"),
    )

    expect(() =>
      loadConfig({
        ...base,
        SKILL_MARKET_WEB_ORIGIN: "http://market.example.com",
        SKILL_MARKET_API_PUBLIC_URL: "http://market.example.com",
        SKILL_MARKET_ALLOW_INSECURE_IP_HTTP: "true",
      }),
    ).toThrow("must use HTTPS unless it is a loopback or private IPv4 address")
  })

  test("allows the internal HTTP OSS endpoint and private-IP public URL only behind separate test flags", () => {
    const base = {
      SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://enterprise.example.com/index.json",
      SKILL_MARKET_OSS_ENDPOINT: "http://oss.internal.example.com",
      SKILL_MARKET_PUBLIC_BASE_URL: "http://10.246.13.226:4211/market-objects/",
    }
    expect(() => loadConfig(base)).toThrow("SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP=true")
    expect(() =>
      loadConfig({ ...base, SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP: "true" }),
    ).toThrow("SKILL_MARKET_ALLOW_INSECURE_PUBLIC_HTTP=true")

    const config = loadConfig({
      ...base,
      SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP: "true",
      SKILL_MARKET_ALLOW_INSECURE_PUBLIC_HTTP: "true",
    })
    expect(config.ossEndpoint).toBe("http://oss.internal.example.com/")
    expect(config.publicBaseUrl).toBe("http://10.246.13.226:4211/market-objects/")
    expect(() =>
      loadConfig({
        ...base,
        SKILL_MARKET_OSS_ENDPOINT: "http://user:secret@oss.internal.example.com",
        SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP: "true",
        SKILL_MARKET_ALLOW_INSECURE_PUBLIC_HTTP: "true",
      }),
    ).toThrow("without credentials")
    expect(() =>
      loadConfig({
        ...base,
        SKILL_MARKET_PUBLIC_BASE_URL: "http://public.example.com/objects/",
        SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP: "true",
        SKILL_MARKET_ALLOW_INSECURE_PUBLIC_HTTP: "true",
      }),
    ).toThrow("private IPv4")
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
