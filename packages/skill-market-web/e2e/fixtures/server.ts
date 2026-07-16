import { communityDetail, communitySummary, detail, facets, summary, version } from "./catalog"

const headers = {
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4210,
  fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers })
    const url = new URL(request.url)
    if (url.pathname === "/health") return Response.json({ ok: true }, { headers })
    if (url.pathname === "/v1/catalog/facets") return Response.json(facets, { headers })
    if (url.pathname === "/v1/catalog/skills") {
      const query = url.searchParams.get("query")?.toLowerCase()
      const source = url.searchParams.get("source")
      const sourceStatus =
        query === "partial"
          ? { skillhub: "stale" as const, enterprise: "unavailable" as const, community: "fresh" as const }
          : facets.sourceStatus
      const items =
        query === "empty" ? [] : [summary, communitySummary].filter((item) => source === null || item.source === source)
      return Response.json(
        {
          revision: "fixture-revision",
          sourceStatus,
          total: items.length,
          page: Number(url.searchParams.get("page") ?? 1),
          limit: Number(url.searchParams.get("limit") ?? 30),
          items,
        },
        { headers },
      )
    }
    if (url.pathname === "/v1/catalog/skills/skillhub/code-review") return Response.json(detail, { headers })
    if (url.pathname === "/v1/catalog/skills/community/safe-community-skill") {
      return Response.json(communityDetail, { headers })
    }
    if (url.pathname === "/v1/catalog/skills/skillhub/code-review/versions") {
      return Response.json([version], { headers })
    }
    if (url.pathname === "/v1/catalog/skills/community/safe-community-skill/versions") {
      return Response.json([version], { headers })
    }
    if (url.pathname === "/v1/catalog/skills/skillhub/code-review/download") {
      return Response.json(
        { url: detail.package.url, sha256: detail.package.sha256, size: detail.package.size },
        { headers },
      )
    }
    if (url.pathname === "/v1/catalog/skills/community/safe-community-skill/download") {
      return Response.json(
        {
          url: communityDetail.package.url,
          sha256: communityDetail.package.sha256,
          size: communityDetail.package.size,
        },
        { headers },
      )
    }
    return Response.json({ error: "not found" }, { status: 404, headers })
  },
})

console.info(`Skill market fixture listening on ${server.url}`)
