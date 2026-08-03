import { expect, test } from "bun:test"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { createRemoteSkillMarketDataSource, MarketHttpError } from "./data-source"

const summary = {
  id: "code-review",
  source: "skillhub",
  sourceUrl: "https://skillhub.cn/skills/code-review",
  name: "Code Review",
  description: "审查代码并发现风险",
  iconUrl: "https://oss.example.com/market/icons/" + "a".repeat(64) + ".png",
  categories: ["代码质量"],
  tags: ["review"],
  requiresApiKey: false,
  risk: "safe",
  version: "1.2.0",
  updatedAt: "2026-07-15T01:00:00.000Z",
  downloads: 1200,
  favorites: 80,
  score: 98.6,
  featured: true,
  enterprise: false,
  delisted: false,
} satisfies SkillMarket.Summary

const page = {
  revision: "revision-1",
  sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
  total: 1,
  page: 1,
  limit: 30,
  items: [summary],
} satisfies SkillMarket.Page

const version = {
  version: "1.2.0",
  publishedAt: "2026-07-15T01:00:00.000Z",
  sha256: "a".repeat(64),
  size: 2048,
} satisfies SkillMarket.Version

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

test("encodes list filters and decodes the response schema", async () => {
  const server = serve((request) => {
    const url = new URL(request.url)
    expect(url.pathname).toBe("/v1/catalog/skills")
    expect(url.searchParams.get("query")).toBe("code review")
    expect(url.searchParams.get("requiresApiKey")).toBe("false")
    expect(url.searchParams.get("unknown")).toBeNull()
    return Response.json(page)
  })
  const source = createRemoteSkillMarketDataSource(server.url)

  const result = await source.list({ query: "code review", requiresApiKey: false, sort: "score", page: 1, limit: 30 })
  const iconUrl = new URL("/v1/catalog/icon", server.url)
  iconUrl.searchParams.set("url", summary.iconUrl)
  expect(result).toMatchObject({ total: 1, items: [{ id: "code-review", iconUrl: iconUrl.href }] })
  await server.stop()
})

test("rejects malformed payloads and non-success responses", async () => {
  const malformed = serve(() => Response.json({ ...page, total: "one" }))
  const malformedSource = createRemoteSkillMarketDataSource(malformed.url)
  await expect(malformedSource.list({ sort: "score", page: 1, limit: 30 })).rejects.toBeTruthy()
  await malformed.stop()

  const unavailable = serve(() => Response.json({ error: "offline" }, { status: 503 }))
  const unavailableSource = createRemoteSkillMarketDataSource(unavailable.url)
  await expect(unavailableSource.facets()).rejects.toEqual(new MarketHttpError(503))
  await unavailable.stop()
})

test("preserves abort signals", async () => {
  const server = serve(() => new Promise<Response>(() => undefined))
  const source = createRemoteSkillMarketDataSource(server.url)
  const controller = new AbortController()
  controller.abort()
  const request = source.facets(controller.signal)
  await expect(request).rejects.toMatchObject({ name: "AbortError" })
  await server.stop()
})

test("escapes detail keys and decodes versions", async () => {
  const paths: string[] = []
  const server = serve((request) => {
    paths.push(new URL(request.url).pathname)
    return Response.json([version])
  })
  const source = createRemoteSkillMarketDataSource(server.url)

  await expect(source.versions({ source: "skillhub", id: "review/with space" })).resolves.toEqual([version])
  expect(paths).toEqual(["/v1/catalog/skills/skillhub/review%2Fwith%20space/versions"])
  await server.stop()
})

test("loads locally served expert package pages and encoded details", async () => {
  const requests: string[] = []
  const expert = {
    slug: "tech-test-automation",
    displayName: "自动化测试",
    summary: "完整测试工作流",
    scene: "tech",
    skillCount: 2,
    updatedAt: "2026-07-23T00:00:00.000Z",
  } satisfies SkillMarket.ExpertPackageSummary
  const server = serve((request) => {
    requests.push(`${new URL(request.url).pathname}${new URL(request.url).search}`)
    if (new URL(request.url).pathname.endsWith("/tech-test-automation"))
      return Response.json({ ...expert, content: "# Workflow", skillSlugs: ["tdd", "e2e"] })
    return Response.json({
      total: 1,
      page: 1,
      limit: 30,
      items: [expert],
      scenes: [{ value: "tech", count: 1 }],
    })
  })
  const source = createRemoteSkillMarketDataSource(server.url)

  await expect(
    source.expertPackages?.list({ query: "自动化", scene: "tech", page: 1, limit: 30 }),
  ).resolves.toMatchObject({ total: 1 })
  await expect(source.expertPackages?.detail("tech-test-automation")).resolves.toMatchObject({
    skillSlugs: ["tdd", "e2e"],
  })
  expect(requests).toEqual([
    "/v1/catalog/expert-packages?query=%E8%87%AA%E5%8A%A8%E5%8C%96&scene=tech&page=1&limit=30",
    "/v1/catalog/expert-packages/tech-test-automation",
  ])
  await server.stop()
})

test("loads announcement history and encoded announcement details", async () => {
  const requests: string[] = []
  const announcement = {
    id: "ann_abcdefgh",
    title: "市场公告",
    summary: "公告摘要",
    content: "# 公告正文",
    publishedAt: "2026-07-24T00:00:00.000Z",
  } satisfies SkillMarket.AnnouncementDetail
  const server = serve((request) => {
    const url = new URL(request.url)
    requests.push(`${url.pathname}${url.search}`)
    if (url.pathname.endsWith("/ann_abcdefgh")) return Response.json(announcement)
    return Response.json({ total: 1, page: 2, limit: 20, items: [announcement] })
  })
  const source = createRemoteSkillMarketDataSource(server.url)

  await expect(source.announcements.list({ page: 2, limit: 20 })).resolves.toMatchObject({ total: 1 })
  await expect(source.announcements.detail("ann_abcdefgh")).resolves.toEqual(announcement)
  expect(requests).toEqual([
    "/v1/catalog/announcements?page=2&limit=20",
    "/v1/catalog/announcements/ann_abcdefgh",
  ])
  await server.stop()
})

test("allows insecure HTTP only for loopback development", () => {
  expect(() => createRemoteSkillMarketDataSource("http://market.example.com")).toThrow("must use HTTPS")
  expect(() => createRemoteSkillMarketDataSource("http://10.246.13.226:4210")).toThrow("must use HTTPS")
  expect(() =>
    createRemoteSkillMarketDataSource("http://10.246.13.226:4210", { allowInsecurePrivateHttp: true }),
  ).not.toThrow()
  expect(() =>
    createRemoteSkillMarketDataSource("http://market.example.com", { allowInsecurePrivateHttp: true }),
  ).toThrow("must use HTTPS")
  expect(() => createRemoteSkillMarketDataSource("http://localhost:4210")).not.toThrow()
  expect(() => createRemoteSkillMarketDataSource("https://market.example.com")).not.toThrow()
})
