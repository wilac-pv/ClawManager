import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { normalizeSkillMarketCatalogQuery } from "@opencode-ai/protocol/groups/skill-market-catalog"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Effect } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { type CatalogSnapshot, key, queryCatalog } from "../catalog"
import type { MarketMetricEmitter } from "../metrics"
import { CatalogPackageReadError, type CatalogPackageReader } from "../package-reader"
import { requestID } from "./middleware"

type SnapshotLoader = () => Promise<CatalogSnapshot>

export function createCatalogHttp(
  loadSnapshot: SnapshotLoader,
  packages: CatalogPackageReader,
  emit?: MarketMetricEmitter,
) {
  return HttpApiBuilder.group(SkillMarketApi, "skillMarket.catalog", (handlers) =>
    handlers
      .handle("skillMarket.catalog.list", (context) =>
        withSnapshot(loadSnapshot, (snapshot) =>
          queryCatalog(snapshot, normalizeSkillMarketCatalogQuery(context.query)),
        ),
      )
      .handle("skillMarket.catalog.facets", () => withSnapshot(loadSnapshot, (snapshot) => snapshot.facets))
      .handle("skillMarket.catalog.detail", (context) =>
        withSnapshot(loadSnapshot, (snapshot) => detail(snapshot, context.params.source, context.params.id)),
      )
      .handle("skillMarket.catalog.versions", (context) =>
        withSnapshot(loadSnapshot, (snapshot) => {
          const value = detail(snapshot, context.params.source, context.params.id)
          return HttpServerResponse.isHttpServerResponse(value) ? value : value.versions
        }),
      )
      .handle("skillMarket.catalog.download", (context) =>
        withSnapshot(loadSnapshot, (snapshot) => {
          const value = detail(snapshot, context.params.source, context.params.id)
          if (HttpServerResponse.isHttpServerResponse(value)) return value
          return { url: value.package.url, sha256: value.package.sha256, size: value.package.size }
        }),
      )
      .handleRaw("skillMarket.catalog.package", (context) =>
        packageResponse(loadSnapshot, packages, context.params.source, context.params.id, false, emit),
      )
      .handleRaw("skillMarket.catalog.packageHead", (context) =>
        packageResponse(loadSnapshot, packages, context.params.source, context.params.id, true, emit),
      ),
  )
}

function packageResponse(
  loadSnapshot: SnapshotLoader,
  packages: CatalogPackageReader,
  source: SkillMarket.Source,
  id: string,
  head: boolean,
  emit?: MarketMetricEmitter,
) {
  const method = head ? "HEAD" : "GET"
  return Effect.tryPromise({ try: loadSnapshot, catch: () => undefined }).pipe(
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
      onSuccess: (snapshot) => {
        const detail = snapshot.details.get(key(source, id))
        if (!detail || detail.delisted) {
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
        return Effect.tryPromise({ try: () => packages.read(detail), catch: (error) => error }).pipe(
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
              const headers = packageHeaders(detail, verified)
              if (head) return HttpServerResponse.empty({ status: 200, headers })
              return HttpServerResponse.uint8Array(verified.body, { headers })
            },
          }),
        )
      },
    }),
  )
}

function withSnapshot<A>(
  loadSnapshot: SnapshotLoader,
  use: (snapshot: CatalogSnapshot) => A,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> {
  return Effect.tryPromise({ try: loadSnapshot, catch: () => undefined }).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ code: "market-unavailable", message: "Skill 市场暂不可用" }, { status: 503 }),
        ),
      onSuccess: (snapshot) =>
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
        ).pipe(Effect.andThen(Effect.sync(() => use(snapshot)))),
    }),
  )
}

function detail(snapshot: CatalogSnapshot, source: Parameters<typeof key>[0], id: string) {
  const value = snapshot.details.get(key(source, id))
  if (value && !value.delisted) return value
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
