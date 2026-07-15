import {
  SkillMarketCatalogQuery,
  normalizeSkillMarketCatalogQuery,
} from "@opencode-ai/protocol/groups/skill-market-catalog"
import { Option, Schema } from "effect"
import { type CatalogSnapshot, key, queryCatalog } from "./catalog"

type SnapshotLoader = () => Promise<CatalogSnapshot>

export function createCatalogHandler(loadSnapshot: SnapshotLoader) {
  return (request: Request) => {
    if (request.method === "OPTIONS") return Promise.resolve(response(null, 204))
    const url = new URL(request.url)
    if (url.pathname === "/health") return Promise.resolve(json({ status: "ok" }, 200, request.method === "HEAD"))
    if (request.method !== "GET" && request.method !== "HEAD")
      return Promise.resolve(json({ code: "method-not-allowed" }, 405, false, { allow: "GET, HEAD, OPTIONS" }))
    return loadSnapshot()
      .then((snapshot) => route(request, url, snapshot))
      .catch(() => json({ code: "market-unavailable", message: "Skill 市场暂不可用" }, 503, request.method === "HEAD"))
  }
}

function route(request: Request, url: URL, snapshot: CatalogSnapshot) {
  const head = request.method === "HEAD"
  const headers = snapshotHeaders(snapshot)
  if (url.pathname === "/v1/catalog/skills") {
    const decoded = Schema.decodeUnknownOption(SkillMarketCatalogQuery)(Object.fromEntries(url.searchParams))
    if (Option.isNone(decoded)) return json({ code: "invalid-query", message: "查询参数无效" }, 400, head, headers)
    return json(queryCatalog(snapshot, normalizeSkillMarketCatalogQuery(decoded.value)), 200, head, headers)
  }
  if (url.pathname === "/v1/catalog/facets") return json(snapshot.facets, 200, head, headers)

  const segments = url.pathname.split("/").filter(Boolean)
  if (segments[0] !== "v1" || segments[1] !== "catalog" || segments[2] !== "skills")
    return json({ code: "not-found" }, 404, head, headers)
  const source = segments[3]
  if (source !== "skillhub" && source !== "enterprise") return json({ code: "not-found" }, 404, head, headers)
  const id = segments[4]
  if (!id) return json({ code: "not-found" }, 404, head, headers)
  const detail = snapshot.details.get(key(source, decodeURIComponent(id)))
  if (!detail || detail.delisted) return json({ code: "not-found" }, 404, head, headers)
  if (segments.length === 5) return json(detail, 200, head, headers)
  if (segments.length !== 6) return json({ code: "not-found" }, 404, head, headers)
  if (segments[5] === "versions") return json(detail.versions, 200, head, headers)
  if (segments[5] === "download")
    return json(
      { url: detail.package.url, sha256: detail.package.sha256, size: detail.package.size },
      200,
      head,
      headers,
    )
  return json({ code: "not-found" }, 404, head, headers)
}

function snapshotHeaders(snapshot: CatalogSnapshot) {
  return {
    "cache-control": "public, max-age=60",
    etag: `"${snapshot.revision}"`,
    "x-skill-market-revision": snapshot.revision,
    "x-skill-market-source-skillhub": snapshot.sourceStatus.skillhub,
    "x-skill-market-source-enterprise": snapshot.sourceStatus.enterprise,
  }
}

function json(value: unknown, status: number, head: boolean, headers?: Record<string, string>) {
  return response(head ? null : JSON.stringify(value), status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  })
}

function response(body: string | null, status: number, headers?: Record<string, string>) {
  return new Response(body, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Accept, Content-Type",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  })
}
