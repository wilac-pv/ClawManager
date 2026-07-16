import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createDesktopSkillMarket, MarketLocalError } from "./desktop-source"

const sha256 = "a".repeat(64)

test("maps every shared operation to the generated local client", async () => {
  const calls: string[] = []
  const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch: createFetch(calls),
  })
  const market = createDesktopSkillMarket(client)

  await market.source.list({ sort: "score", page: 1, limit: 30 })
  await market.source.facets()
  await market.source.detail({ source: "skillhub", id: "code-review" })
  await market.source.versions({ source: "skillhub", id: "code-review" })
  await market.source.installed?.()
  await market.source.updates?.()
  if (market.actions.kind !== "desktop") throw new Error("expected desktop actions")
  await market.actions.install(installRequest())
  await market.actions.update(installRequest("2.0.0"))
  await market.actions.uninstall({ source: "skillhub", id: "code-review" })
  await market.actions.refresh({ source: "skillhub", id: "code-review" })

  expect(calls).toEqual([
    "list?sort=score&page=1&limit=30",
    "facets",
    "detail",
    "detail",
    "installed",
    "updates",
    "install",
    "update",
    "uninstall",
    "refresh",
  ])
})

test("preserves stable local error codes", async () => {
  const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    fetch: asFetch(async () =>
      Response.json(
        {
          name: "SkillMarketConflictError",
          code: "risk-confirmation-required",
          message: "需要确认风险",
        },
        { status: 409 },
      ),
    ),
  })
  const market = createDesktopSkillMarket(client)
  if (market.actions.kind !== "desktop") throw new Error("expected desktop actions")

  await expect(market.actions.install(installRequest())).rejects.toEqual(
    expect.objectContaining({
      name: "MarketLocalError",
      code: "risk-confirmation-required",
      message: "需要确认风险",
    }),
  )
  expect(MarketLocalError.from(new Error("private path")).code).toBe("market-unavailable")
})

function installRequest(version = "1.0.0") {
  return {
    source: "skillhub" as const,
    id: "code-review",
    version,
    sha256,
  }
}

function createFetch(calls: string[]): typeof fetch {
  return asFetch(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const name = operation(request.method, url.pathname)
    calls.push(name === "list" ? `${name}?${url.searchParams.toString()}` : name)
    if (name === "facets") return Response.json(facets())
    if (name === "detail") return Response.json(detail())
    if (name === "installed" || name === "updates") return Response.json([installed()])
    if (name === "install" || name === "update") return Response.json({ installed: installed(), changed: true })
    if (name === "uninstall" || name === "refresh") return new Response(undefined, { status: 204 })
    return Response.json(page())
  })
}

function asFetch(run: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
  return Object.assign(run, { preconnect: () => undefined })
}

function operation(method: string, path: string) {
  if (path === "/api/skill/market/skills") return "list"
  if (path === "/api/skill/market/facets") return "facets"
  if (path === "/api/skill/market/installed") return "installed"
  if (path === "/api/skill/market/updates") return "updates"
  if (path === "/api/skill/market/install" && method === "POST") return "install"
  if (path.endsWith("/refresh")) return "refresh"
  if (path.startsWith("/api/skill/market/install/")) return "uninstall"
  if (path.startsWith("/api/skill/market/skills/")) return "detail"
  if (path === "/api/skill/market/update") return "update"
  throw new Error(`Unexpected request: ${method} ${path}`)
}

function page() {
  return {
    revision: "revision",
    sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
    total: 1,
    page: 1,
    limit: 30,
    items: [summary()],
  }
}

function facets() {
  return {
    revision: "revision",
    sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
    sources: [{ value: "skillhub", count: 1 }],
    categories: [{ value: "engineering", count: 1 }],
    requiresApiKey: { yes: 0, no: 1 },
  }
}

function summary() {
  return {
    id: "code-review",
    source: "skillhub",
    sourceUrl: "https://skillhub.cn/skills/code-review",
    name: "Code Review",
    description: "Review code",
    categories: ["engineering"],
    tags: ["review"],
    requiresApiKey: false,
    risk: "safe",
    version: "1.0.0",
    updatedAt: "2026-07-15T00:00:00.000Z",
    downloads: 1,
    favorites: 0,
    score: 1,
    featured: false,
    enterprise: false,
    delisted: false,
  }
}

function detail() {
  return {
    ...summary(),
    readme: "# Code Review",
    author: { name: "Ruying" },
    versions: [{ version: "1.0.0", publishedAt: "2026-07-15T00:00:00.000Z", sha256, size: 1 }],
    securityReports: [],
    package: { url: "https://example.com/code-review.zip", sha256, size: 1, files: [] },
    publicDetailUrl: "https://skillhub.cn/skills/code-review",
  }
}

function installed() {
  return {
    source: "skillhub",
    id: "code-review",
    name: "Code Review",
    version: "1.0.0",
    installedAt: "2026-07-15T00:00:00.000Z",
    updateAvailable: false,
    loadState: "ready",
  }
}
