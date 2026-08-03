import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { normalizeSkillMarketCatalogQuery } from "@opencode-ai/protocol/groups/skill-market-catalog"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Effect } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { CatalogReader } from "../catalog-reader"
import type { CatalogIconProxy } from "../catalog-icon"
import type { MarketMetricEmitter } from "../metrics"
import { CatalogPackageReadError, type CatalogPackageReader } from "../package-reader"
import { requestID } from "./middleware"

export function createCatalogHttp(
  catalog: CatalogReader,
  packages: CatalogPackageReader,
  icons: CatalogIconProxy,
  emit?: MarketMetricEmitter,
) {
  return HttpApiBuilder.group(SkillMarketApi, "skillMarket.catalog", (handlers) =>
    handlers
      .handle("skillMarket.catalog.list", (context) =>
        withCatalog(catalog, (current) =>
          catalog.list(normalizeSkillMarketCatalogQuery(context.query), current).then(icons.rewritePage),
        ),
      )
      .handle("skillMarket.catalog.facets", () => withCatalog(catalog, (current) => catalog.facets(current)))
      .handle("skillMarket.catalog.detail", (context) =>
        withCatalog(catalog, (current) => detail(catalog, current, context.params.source, context.params.id, icons)),
      )
      .handle("skillMarket.catalog.versions", (context) =>
        withCatalog(catalog, async (current) => {
          const value = await detail(catalog, current, context.params.source, context.params.id, icons)
          return HttpServerResponse.isHttpServerResponse(value) ? value : value.versions
        }),
      )
      .handle("skillMarket.catalog.download", (context) =>
        withCatalog(catalog, async (current) => {
          const value = await detail(catalog, current, context.params.source, context.params.id, icons)
          if (HttpServerResponse.isHttpServerResponse(value)) return value
          return { url: value.package.url, sha256: value.package.sha256, size: value.package.size }
        }),
      )
      .handleRaw("skillMarket.catalog.package", (context) =>
        packageResponse(catalog, packages, context.params.source, context.params.id, false, emit),
      )
      .handleRaw("skillMarket.catalog.packageHead", (context) =>
        packageResponse(catalog, packages, context.params.source, context.params.id, true, emit),
      ),
  )
}

function packageResponse(
  catalog: CatalogReader,
  packages: CatalogPackageReader,
  source: SkillMarket.Source,
  id: string,
  head: boolean,
  emit?: MarketMetricEmitter,
) {
  const method = head ? "HEAD" : "GET"
  return Effect.tryPromise({ try: () => catalog.detail(source, id), catch: () => undefined }).pipe(
    Effect.matchEffect({
      onFailure: () => {
        const requestId = requestID()
        emit?.({
          skill_market_package_delivery: {
            failure: 1,
            source,
            id,
            method,
            phase: "snapshot",
            request_id: requestId,
          },
        })
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { code: "market-unavailable", message: "Skill 市场暂不可用", requestId },
            { status: 503 },
          ),
        )
      },
      onSuccess: (value) => {
        if (!value || value.delisted) {
          const problem = packageNotFoundProblem(source, id)
          emit?.({
            skill_market_package_delivery: {
              failure: 1,
              source,
              id,
              method,
              phase: problem.phase,
              request_id: problem.body.requestId,
            },
          })
          return Effect.succeed(HttpServerResponse.jsonUnsafe(problem.body, { status: problem.status }))
        }
        return Effect.tryPromise({ try: () => packages.read(value), catch: (error) => error }).pipe(
          Effect.match({
            onFailure: (error) => {
              const problem = packageReadProblem(error, source, id)
              emit?.({
                skill_market_package_delivery: {
                  failure: 1,
                  source,
                  id,
                  method,
                  phase: problem.phase,
                  request_id: problem.body.requestId,
                },
              })
              return HttpServerResponse.jsonUnsafe(problem.body, { status: problem.status })
            },
            onSuccess: (verified) => {
              emit?.({ skill_market_package_delivery: { success: 1, source, id, method } })
              const headers = packageHeaders(value, verified)
              if (head) return HttpServerResponse.empty({ status: 200, headers })
              return HttpServerResponse.uint8Array(verified.body, { headers })
            },
          }),
        )
      },
    }),
  )
}

function withCatalog<A>(
  catalog: CatalogReader,
  use: (current: Awaited<ReturnType<CatalogReader["index"]>>) => Promise<A>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> {
  return Effect.tryPromise({
    try: async () => {
      const current = await catalog.index()
      return [current, await use(current)] as const
    },
    catch: () => undefined,
  }).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ code: "market-unavailable", message: "Skill 市场暂不可用" }, { status: 503 }),
        ),
      onSuccess: ([snapshot, value]) =>
        HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(
            HttpServerResponse.setHeaders(response, {
              "cache-control": "public, max-age=60",
              etag: `"${snapshot.revision}"`,
              "x-skill-market-revision": snapshot.revision,
              "x-skill-market-source-skillhub": snapshot.sourceStatus.skillhub,
              "x-skill-market-source-enterprise": snapshot.sourceStatus.enterprise,
              "x-skill-market-source-community": snapshot.sourceStatus.community,
            }),
          ),
        ).pipe(Effect.andThen(Effect.succeed(value))),
    }),
  )
}

async function detail(
  catalog: CatalogReader,
  current: Awaited<ReturnType<CatalogReader["index"]>>,
  source: Parameters<CatalogReader["detail"]>[0],
  id: string,
  icons: CatalogIconProxy,
) {
  const value = await catalog.detail(source, id, current)
  if (value && !value.delisted) return icons.rewriteDetail(value)
  return HttpServerResponse.jsonUnsafe({ source, id }, { status: 404 })
}

export function packageHeaders(detail: SkillMarket.Detail, verified: { sha256: string; size: number }) {
  const filename = `${detail.source}-${detail.id}-${detail.version}.zip`.replace(/[^a-zA-Z0-9._-]/g, "_")
  return {
    "cache-control": "public, max-age=31536000, immutable",
    "content-disposition": `attachment; filename="${filename}"`,
    "content-length": String(verified.size),
    "content-type": "application/zip",
    etag: `"${verified.sha256}"`,
    "x-content-sha256": verified.sha256,
  }
}

export function packageNotFoundProblem(source: SkillMarket.Source, id: string) {
  return {
    status: 404,
    phase: "detail",
    body: {
      code: "skill-market-not-found",
      message: "Skill 包不存在",
      requestId: requestID(),
      source,
      id,
    },
  } as const
}

export function packageReadProblem(error: unknown, source: SkillMarket.Source, id: string) {
  const tooLarge = error instanceof CatalogPackageReadError && error.kind === "too-large"
  return {
    status: tooLarge ? 413 : 502,
    phase: error instanceof CatalogPackageReadError ? error.phase : "get",
    body: {
      code: tooLarge ? "skill-market-package-too-large" : "skill-market-package-unavailable",
      message: tooLarge ? "Skill 包超过大小限制" : "Skill 包暂不可用",
      requestId: requestID(),
      source,
      id,
    },
  } as const
}
