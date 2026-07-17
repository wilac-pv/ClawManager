import {
  SkillMarketCatalogQuery,
  normalizeSkillMarketCatalogQuery,
} from "@opencode-ai/protocol/groups/skill-market-catalog"
import { Option, Schema } from "effect"
import { Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { SkillMarketPrincipal } from "@opencode-ai/protocol/skill-market-middleware"
import type { createAuth } from "./auth"
import { type CatalogSnapshot, key, queryCatalog } from "./catalog"
import type { CatalogReader } from "./catalog-reader"
import type { MarketMetricEmitter } from "./metrics"
import type { Moderation } from "./moderation"
import type { PrivateObjectStore } from "./oss"
import type { MarketSecurity } from "./security"
import type { SkillHubImportAdmin } from "./skillhub-import-admin"
import { randomSecret } from "./security"
import type { Submissions } from "./submissions"
import { createAdminHttp } from "./http/admin"
import { createAuthHttp } from "./http/auth"
import { createCatalogHttp } from "./http/catalog"
import { createSecurityLayers } from "./http/middleware"
import { createSubmissionsHttp } from "./http/submissions"

export interface MarketHttpOptions {
  readonly catalog?: CatalogReader
  readonly loadSnapshot?: () => Promise<CatalogSnapshot>
  readonly auth: ReturnType<typeof createAuth>
  readonly security: MarketSecurity
  readonly submissions: Submissions
  readonly moderation: Moderation
  readonly skillhubImportAdmin: SkillHubImportAdmin
  readonly store: PrivateObjectStore
  readonly privatePrefix: string
  readonly webOrigin: string
  readonly webBaseUrl: string
  readonly sessionCookieName: string
  readonly cookieSecure: boolean
  readonly sessionCookieMaxAgeSeconds: number
  readonly onWorkReady?: () => void
  readonly onSkillHubWorkReady?: () => void
  readonly emit?: MarketMetricEmitter
}

export function createMarketRoutes(options: MarketHttpOptions) {
  const catalog = options.catalog ?? (options.loadSnapshot ? readerFromSnapshot(options.loadSnapshot) : undefined)
  if (!catalog) throw new Error("catalog reader is required")
  const groups = [
    createCatalogHttp(catalog),
    createAuthHttp(options),
    createSubmissionsHttp(options),
    createAdminHttp(options),
  ] as const
  const api = HttpApiBuilder.layer(SkillMarketApi).pipe(
    Layer.provide([...groups]),
    Layer.provide([...createSecurityLayers(options)]),
  )
  return Layer.mergeAll(
    api,
    HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ status: "ok", ready: true })),
  ).pipe(
    Layer.provide(controlHeaders(options.webOrigin)),
    // HttpApi's inherited group middleware leaves the provided principal in the
    // route build type. Auth middleware always replaces this expired sentinel
    // before a protected handler can run.
    Layer.provide(
      Layer.succeed(SkillMarketPrincipal, {
        user: { employeeID: "anonymous", displayName: "Anonymous" },
        roles: [],
        csrfToken: "_".repeat(43),
        createdAt: "1970-01-01T00:00:00.000Z",
        absoluteExpiresAt: "1970-01-01T00:00:00.000Z",
        idleExpiresAt: "1970-01-01T00:00:00.000Z",
      }),
    ),
  )
}

function readerFromSnapshot(loadSnapshot: () => Promise<CatalogSnapshot>): CatalogReader {
  const index = async () => {
    const snapshot = await loadSnapshot()
    return {
      revision: snapshot.revision,
      createdAt: snapshot.createdAt,
      items: snapshot.items,
      details: new Map(),
      facets: snapshot.facets,
      sourceStatus: snapshot.sourceStatus,
    }
  }
  const detail = async (source: Parameters<CatalogReader["detail"]>[0], id: string) =>
    (await loadSnapshot()).details.get(key(source, id))
  return {
    index,
    async list(query) {
      return queryCatalog(await loadSnapshot(), query)
    },
    async facets() {
      return (await loadSnapshot()).facets
    },
    detail,
    async versions(source, id) {
      return (await detail(source, id))?.versions
    },
    async download(source, id) {
      const value = await detail(source, id)
      if (!value) return undefined
      return { url: value.package.url, sha256: value.package.sha256, size: value.package.size }
    },
  }
}

export function createMarketWebHandler(options: MarketHttpOptions) {
  return HttpRouter.toWebHandler(createMarketRoutes(options).pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  })
}

function controlHeaders(webOrigin: string) {
  return HttpRouter.middleware(
    (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const catalog = url.pathname.startsWith("/v1/catalog/")
        const control =
          url.pathname.startsWith("/v1/auth/") ||
          url.pathname.startsWith("/v1/submissions") ||
          url.pathname.startsWith("/v1/admin/")
        const origin = request.headers.origin
        const baseHeaders = {
          "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        }
        const corsHeaders = catalog
          ? {
              "access-control-allow-origin": "*",
              "access-control-allow-methods": "GET, HEAD, OPTIONS",
              "access-control-allow-headers": "Accept, Content-Type",
            }
          : control
            ? {
                ...(origin === webOrigin ? { "access-control-allow-origin": webOrigin } : {}),
                "access-control-allow-credentials": "true",
                "access-control-allow-methods": "GET, HEAD, POST, DELETE, OPTIONS",
                "access-control-allow-headers": "Accept, Content-Type, Idempotency-Key, X-CSRF-Token",
                vary: "Origin",
                "cache-control": "no-store",
              }
            : {}
        if (request.method === "OPTIONS")
          return HttpServerResponse.empty({ status: 204, headers: { ...baseHeaders, ...corsHeaders } })
        yield* HttpEffect.appendPreResponseHandler((_request, response) => {
          const invalidBody =
            control &&
            ((response.body._tag === "Empty" &&
              (response.status === 400 ||
                (response.status >= 500 &&
                  (request.headers["content-type"]?.startsWith("application/json") ||
                    request.headers["content-type"]?.startsWith("multipart/form-data"))))) ||
              response.status === 415)
              ? HttpServerResponse.jsonUnsafe(
                  {
                    code: "invalid-request",
                    message: "请求内容无效",
                    requestId: `req_${randomSecret().slice(0, 16)}`,
                  },
                  { status: 400 },
                )
              : response
          const safeBody =
            control && invalidBody.body._tag === "Empty" && invalidBody.status >= 500
              ? HttpServerResponse.jsonUnsafe(
                  {
                    code: "dependency-unavailable",
                    message: "服务暂不可用",
                    requestId: `req_${randomSecret().slice(0, 16)}`,
                  },
                  { status: 503 },
                )
              : invalidBody
          return Effect.succeed(HttpServerResponse.setHeaders(safeBody, { ...baseHeaders, ...corsHeaders }))
        })
        return yield* effect
      }),
    { global: true },
  )
}

export function createCatalogHandler(catalog: CatalogReader) {
  return (request: Request) => {
    if (request.method === "OPTIONS") return Promise.resolve(response(null, 204))
    const url = new URL(request.url)
    if (url.pathname === "/health") return Promise.resolve(json({ status: "ok" }, 200, request.method === "HEAD"))
    if (request.method !== "GET" && request.method !== "HEAD")
      return Promise.resolve(json({ code: "method-not-allowed" }, 405, false, { allow: "GET, HEAD, OPTIONS" }))
    return catalog.index()
      .then((index) => route(request, url, index, catalog))
      .catch(() => json({ code: "market-unavailable", message: "Skill 市场暂不可用" }, 503, request.method === "HEAD"))
  }
}

function route(request: Request, url: URL, index: Awaited<ReturnType<CatalogReader["index"]>>, catalog: CatalogReader) {
  const head = request.method === "HEAD"
  const headers = snapshotHeaders(index)
  if (url.pathname === "/v1/catalog/skills") {
    const decoded = Schema.decodeUnknownOption(SkillMarketCatalogQuery)(Object.fromEntries(url.searchParams))
    if (Option.isNone(decoded)) return json({ code: "invalid-query", message: "查询参数无效" }, 400, head, headers)
    return catalog.list(normalizeSkillMarketCatalogQuery(decoded.value)).then((value) => json(value, 200, head, headers))
  }
  if (url.pathname === "/v1/catalog/facets") return catalog.facets().then((value) => json(value, 200, head, headers))

  const segments = url.pathname.split("/").filter(Boolean)
  if (segments[0] !== "v1" || segments[1] !== "catalog" || segments[2] !== "skills")
    return json({ code: "not-found" }, 404, head, headers)
  const source = segments[3]
  if (source !== "skillhub" && source !== "enterprise" && source !== "community")
    return json({ code: "not-found" }, 404, head, headers)
  const id = segments[4]
  if (!id) return json({ code: "not-found" }, 404, head, headers)
  const decodedID = decodeURIComponent(id)
  if (segments.length === 5)
    return catalog.detail(source, decodedID).then((detail) =>
      !detail || detail.delisted ? json({ code: "not-found" }, 404, head, headers) : json(detail, 200, head, headers),
    )
  if (segments.length !== 6) return json({ code: "not-found" }, 404, head, headers)
  if (segments[5] === "versions")
    return catalog.detail(source, decodedID).then((detail) =>
      !detail || detail.delisted
        ? json({ code: "not-found" }, 404, head, headers)
        : json(detail.versions, 200, head, headers),
    )
  if (segments[5] === "download")
    return catalog.detail(source, decodedID).then((detail) =>
      !detail || detail.delisted
        ? json({ code: "not-found" }, 404, head, headers)
        : json({ url: detail.package.url, sha256: detail.package.sha256, size: detail.package.size }, 200, head, headers),
    )
  return json({ code: "not-found" }, 404, head, headers)
}

function snapshotHeaders(snapshot: Awaited<ReturnType<CatalogReader["index"]>>) {
  return {
    "cache-control": "public, max-age=60",
    etag: `"${snapshot.revision}"`,
    "x-skill-market-revision": snapshot.revision,
    "x-skill-market-source-skillhub": snapshot.sourceStatus.skillhub,
    "x-skill-market-source-enterprise": snapshot.sourceStatus.enterprise,
    "x-skill-market-source-community": snapshot.sourceStatus.community,
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
