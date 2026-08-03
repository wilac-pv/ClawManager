import { describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { loadConfig } from "../src/config"
import { loadEnterprise } from "../src/enterprise"
import { loadSkillHub, loadSkillHubRecommendations } from "../src/skillhub"
import { sampleDetail } from "./fixture"

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

    const cached = sampleDetail({
      updatedAt: "2026-07-14T21:21:41.275Z",
      iconUrl: "https://oss.example.com/icons/code-review.png",
    })
    const reusedDetail = await loadSkillHub(
      async (input) => {
        const url = requestUrl(input)
        if (!url.includes("/api/skills?")) throw new Error(`unexpected refresh ${url}`)
        return new Response(Bun.file(new URL("skillhub-page.json", fixtures)), {
          headers: { "content-type": "application/json" },
        })
      },
      "https://api.skillhub.cn",
      new Map([[cached.id, cached]]),
    )
    expect(reusedDetail[0]).toBe(cached)
  })

  test("refreshes an unchanged cached detail when SkillHub now provides an icon", async () => {
    const cached = sampleDetail({ updatedAt: "2026-07-14T21:21:41.275Z" })
    const calls: string[] = []
    const records = await loadSkillHub(
      async (input) => {
        const url = requestUrl(input)
        calls.push(url)
        if (url.includes("/api/skills?"))
          return new Response(Bun.file(new URL("skillhub-page.json", fixtures)), {
            headers: { "content-type": "application/json" },
          })
        const file = url.includes("/files?")
          ? "skillhub-files.json"
          : url.endsWith("/versions")
            ? "skillhub-versions.json"
            : "skillhub-detail.json"
        return new Response(Bun.file(new URL(file, fixtures)), { headers: { "content-type": "application/json" } })
      },
      "https://api.skillhub.cn",
      new Map([[cached.id, cached]]),
    )

    expect(records[0]).not.toBe(cached)
    expect(records[0]?.iconUrl).toBe("https://cloudcache.tencent-cloud.com/code-review.png")
    expect(calls).toHaveLength(4)
  })

  test("bounds SkillHub list page concurrency", async () => {
    let active = 0
    let maximum = 0
    const records = await loadSkillHub(async (input) => {
      const url = requestUrl(input)
      if (!url.includes("/api/skills?")) throw new Error(`unexpected record request ${url}`)
      active += 1
      maximum = Math.max(maximum, active)
      await Bun.sleep(5)
      active -= 1
      return Response.json({ code: 0, data: { skills: [], total: 501 }, message: "ok" })
    }, "https://api.skillhub.cn")

    expect(records).toEqual([])
    expect(maximum).toBeLessThanOrEqual(4)
  })

  test("loads every official SkillHub recommendation without a local limit", async () => {
    const slugs = Array.from({ length: 100 }, (_, index) => `recommended-${index + 1}`)
    const calls: string[] = []
    const recommendations = await loadSkillHubRecommendations(async (input) => {
      calls.push(requestUrl(input))
      return Response.json({
        section: "recommended",
        total: slugs.length,
        skills: slugs.map((slug) => ({ slug })),
      })
    }, "https://api.skillhub.cn")

    expect(calls).toEqual(["https://api.skillhub.cn/api/v1/showcase/recommended"])
    expect(Array.from(recommendations)).toEqual(slugs)
  })

  test("rejects malformed and cross-host recommendation responses", async () => {
    await expect(
      loadSkillHubRecommendations(
        async () => Response.json({ section: "recommended", total: 1, skills: [{}] }),
        "https://api.skillhub.cn",
      ),
    ).rejects.toThrow()

    await expect(
      loadSkillHubRecommendations(async () => {
        const response = Response.json({ section: "recommended", total: 1, skills: [{ slug: "safe" }] })
        Object.defineProperty(response, "url", { value: "https://evil.example.com/api/v1/showcase/recommended" })
        return response
      }, "https://api.skillhub.cn"),
    ).rejects.toThrow("redirected outside")
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
    expect(config.skillhubEvaluationConcurrency).toBe(2)
    expect(config.skillhubEvaluationRequestsPerMinute).toBe(60)
    expect(config.skillhubEvaluationRefreshDays).toBe(7)
    expect(config.skillhubEvaluationPublishBatch).toBe(100)
    expect(config.skillhubEvaluationPublishMinutes).toBe(30)
    expect(config.skillhubEvaluationDurationMilliseconds).toBe(75_000)
    expect(config.skillhubMemorySoftLimitMb).toBe(1_536)
    expect(config.allowedHosts).toEqual(
      new Set([
        "api.skillhub.cn",
        "cloudcache.tencent-cloud.com",
        "docs.cloudbase.net",
        "skillhub-1388575217.cos.accelerate.myqcloud.com",
      ]),
    )
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
    expect(() =>
      loadConfig({
        SKILL_MARKET_SKILLHUB_EVALUATION_REQUESTS_PER_MINUTE: "61",
        SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
        SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
        SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com",
      }),
    ).toThrow("SKILL_MARKET_SKILLHUB_EVALUATION_REQUESTS_PER_MINUTE")
  })

  test("prefers canonical TRACE evaluation settings and accepts legacy aliases", () => {
    const environment = {
      SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
      SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
      SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com",
    }
    const legacy = loadConfig({
      ...environment,
      SKILL_MARKET_SKILLHUB_EVALUATION_CONCURRENCY: "1",
      SKILL_MARKET_SKILLHUB_EVALUATION_REQUESTS_PER_MINUTE: "59",
      SKILL_MARKET_SKILLHUB_EVALUATION_REFRESH_DAYS: "6",
      SKILL_MARKET_SKILLHUB_EVALUATION_PUBLISH_BATCH: "99",
    })
    expect(legacy.skillhubEvaluationConcurrency).toBe(1)
    expect(legacy.skillhubEvaluationRequestsPerMinute).toBe(59)
    expect(legacy.skillhubEvaluationRefreshDays).toBe(6)
    expect(legacy.skillhubEvaluationPublishBatch).toBe(99)

    const canonical = loadConfig({
      ...environment,
      SKILL_MARKET_SKILLHUB_EVALUATION_CONCURRENCY: "1",
      SKILL_MARKET_EVALUATION_CONCURRENCY: "2",
      SKILL_MARKET_SKILLHUB_EVALUATION_REQUESTS_PER_MINUTE: "59",
      SKILL_MARKET_EVALUATION_REQUESTS_PER_MINUTE: "60",
      SKILL_MARKET_SKILLHUB_EVALUATION_REFRESH_DAYS: "6",
      SKILL_MARKET_EVALUATION_REFRESH_DAYS: "7",
      SKILL_MARKET_SKILLHUB_EVALUATION_PUBLISH_BATCH: "99",
      SKILL_MARKET_EVALUATION_PUBLISH_BATCH: "100",
    })
    expect(canonical.skillhubEvaluationConcurrency).toBe(2)
    expect(canonical.skillhubEvaluationRequestsPerMinute).toBe(60)
    expect(canonical.skillhubEvaluationRefreshDays).toBe(7)
    expect(canonical.skillhubEvaluationPublishBatch).toBe(100)
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
