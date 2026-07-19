import {
  SkillMarketCatalogQuery,
  normalizeSkillMarketCatalogQuery,
} from "@opencode-ai/protocol/groups/skill-market-catalog"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Option, Schema } from "effect"
import { Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { SkillMarketPrincipal } from "@opencode-ai/protocol/skill-market-middleware"
import type { createAuth } from "./auth"
import { type CatalogSnapshot, key, queryCatalog } from "./catalog"
import type { MarketMetricEmitter } from "./metrics"
import type { Moderation } from "./moderation"
import type { PrivateObjectStore } from "./oss"
import type { MarketSecurity } from "./security"
import { randomSecret } from "./security"
import type { Submissions } from "./submissions"
import { createAdminHttp } from "./http/admin"
import { createAuthHttp } from "./http/auth"
import { createCatalogHttp, packageHeaders, packageNotFoundProblem, packageReadProblem } from "./http/catalog"
import { createSecurityLayers } from "./http/middleware"
import { createSubmissionsHttp } from "./http/submissions"
import { createCatalogPackageReader, type CatalogPackageReader } from "./package-reader"

type SnapshotLoader = () => Promise<CatalogSnapshot>

export interface MarketHttpOptions {
  readonly loadSnapshot: SnapshotLoader
  readonly auth: ReturnType<typeof createAuth>
  readonly security: MarketSecurity
  readonly submissions: Submissions
  readonly moderation: Moderation
  readonly store: PrivateObjectStore
  readonly privatePrefix: string
  readonly publicPrefix: string
  readonly webOrigin: string
  readonly webBaseUrl: string
  readonly sessionCookieName: string
  readonly cookieSecure: boolean
  readonly sessionCookieMaxAgeSeconds: number
  readonly onWorkReady?: () => void
  readonly emit?: MarketMetricEmitter
}

export function createMarketRoutes(options: MarketHttpOptions) {
  const packages = createCatalogPackageReader(options.store, options.publicPrefix)
  const groups = [
    createCatalogHttp(options.loadSnapshot, packages, options.emit),
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

export function createCatalogHandler(loadSnapshot: SnapshotLoader, packages?: CatalogPackageReader) {
  return (request: Request) => {
    if (request.method === "OPTIONS") return Promise.resolve(response(null, 204))
    const url = new URL(request.url)
    if (url.pathname === "/health") return Promise.resolve(json({ status: "ok" }, 200, request.method === "HEAD"))
    if (request.method !== "GET" && request.method !== "HEAD")
      return Promise.resolve(json({ code: "method-not-allowed" }, 405, false, { allow: "GET, HEAD, OPTIONS" }))
    return loadSnapshot()
      .then((snapshot) => route(request, url, snapshot, packages))
      .catch(() => json({ code: "market-unavailable", message: "Skill 市场暂不可用" }, 503, request.method === "HEAD"))
  }
}

function route(request: Request, url: URL, snapshot: CatalogSnapshot, packages: CatalogPackageReader | undefined) {
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
  if (source !== "skillhub" && source !== "enterprise" && source !== "community")
    return json({ code: "not-found" }, 404, head, headers)
  const id = segments[4]
  if (!id) return json({ code: "not-found" }, 404, head, headers)
  const decodedID = decodeURIComponent(id)
  const detail = snapshot.details.get(key(source, decodedID))
  const packageRoute = segments.length === 6 && segments[5] === "package"
  if ((!detail || detail.delisted) && packageRoute) {
    const problem = packageNotFoundProblem(source, decodedID)
    return json(problem.body, problem.status, head)
  }
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
  if (segments[5] === "package") return packageWebResponse(packages, detail, head)
  return json({ code: "not-found" }, 404, head, headers)
}

async function packageWebResponse(
  packages: CatalogPackageReader | undefined,
  detail: SkillMarket.Detail,
  head: boolean,
) {
  if (!packages) {
    const problem = packageReadProblem(undefined, detail.source, detail.id)
    return json(problem.body, problem.status, head)
  }
  return packages
    .read(detail)
    .then((verified) => response(head ? null : verified.body, 200, packageHeaders(detail, verified)))
    .catch((error) => {
      const problem = packageReadProblem(error, detail.source, detail.id)
      return json(problem.body, problem.status, head)
    })
}

function snapshotHeaders(snapshot: CatalogSnapshot) {
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

function response(body: string | Uint8Array | null, status: number, headers?: Record<string, string>) {
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
