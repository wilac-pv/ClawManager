import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import {
  SkillMarketControlNotFound,
  SkillMarketDependencyUnavailable,
} from "@opencode-ai/protocol/skill-market-errors"
import { SkillMarketPrincipal } from "@opencode-ai/protocol/skill-market-middleware"
import { normalizeSkillMarketCatalogQuery } from "@opencode-ai/protocol/groups/skill-market-catalog"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Effect, Layer } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { CatalogReader } from "../catalog-reader"
import type { InstallGrants } from "../install-grants"
import type { MarketMetricEmitter } from "../metrics"
import { CatalogPackageReadError, type CatalogPackageReader } from "../package-reader"
import type { RestrictedCatalog } from "../restricted-catalog"
import type { MarketSecurity, Principal } from "../security"
import { SkillMarketSecurityError } from "../security"
import { principalFromSession, readCookies, requestID } from "./middleware"

interface CatalogHttpOptions {
  readonly catalog: CatalogReader
  readonly packages: CatalogPackageReader
  readonly restrictedCatalog: RestrictedCatalog
  readonly installGrants: InstallGrants
  readonly security: MarketSecurity
  readonly sessionCookieName: string
  readonly emit?: MarketMetricEmitter
}

export function createCatalogHttp(options: CatalogHttpOptions) {
  const catalog = HttpApiBuilder.group(SkillMarketApi, "skillMarket.catalog", (handlers) =>
    handlers
      .handle("skillMarket.catalog.list", (context) =>
        Effect.gen(function* () {
          const principal = yield* optionalPrincipal(options)
          return yield* withCatalog(
            options.catalog,
            (current) => options.catalog.list(normalizeSkillMarketCatalogQuery(context.query), current, principal),
            Boolean(principal),
          )
        }),
      )
      .handle("skillMarket.catalog.facets", () =>
        Effect.gen(function* () {
          const principal = yield* optionalPrincipal(options)
          return yield* withCatalog(
            options.catalog,
            (current) => options.catalog.facets(current, principal),
            Boolean(principal),
          )
        }),
      )
      .handle("skillMarket.catalog.detail", (context) =>
        withCatalog(options.catalog, (current) =>
          detail(options.catalog, current, context.params.source, context.params.id),
        ),
      )
      .handle("skillMarket.catalog.versions", (context) =>
        withCatalog(options.catalog, async (current) => {
          const value = await detail(options.catalog, current, context.params.source, context.params.id)
          return HttpServerResponse.isHttpServerResponse(value) ? value : value.versions
        }),
      )
      .handle("skillMarket.catalog.download", (context) =>
        withCatalog(options.catalog, async (current) => {
          const value = await detail(options.catalog, current, context.params.source, context.params.id)
          if (HttpServerResponse.isHttpServerResponse(value)) return value
          return { url: value.package.url, sha256: value.package.sha256, size: value.package.size }
        }),
      )
      .handleRaw("skillMarket.catalog.package", (context) =>
        packageResponse(
          options.catalog,
          options.packages,
          context.params.source,
          context.params.id,
          false,
          options.emit,
        ),
      )
      .handleRaw("skillMarket.catalog.packageHead", (context) =>
        packageResponse(
          options.catalog,
          options.packages,
          context.params.source,
          context.params.id,
          true,
          options.emit,
        ),
      ),
  )
  const restricted = HttpApiBuilder.group(SkillMarketApi, "skillMarket.catalogPrivate", (handlers) =>
    handlers
      .handle("skillMarket.catalog.restrictedDetail", (context) =>
        privateCatalogResponse(options, (principal) =>
          options.restrictedCatalog.detail(principal, context.params.publicationID),
        ),
      )
      .handle("skillMarket.catalog.restrictedVersions", (context) =>
        privateCatalogResponse(options, (principal) =>
          options.restrictedCatalog.versions(principal, context.params.publicationID),
        ),
      )
      .handle("skillMarket.catalog.privateInstallGrant", (context) =>
        privateHeaders(
          Effect.gen(function* () {
            const principal = principalFromSession(yield* SkillMarketPrincipal)
            return yield* Effect.tryPromise({
              try: () => options.installGrants.issue(principal, context.params.publicationID),
              catch: restrictedProblem,
            })
          }),
        ),
      ),
  )
  return Layer.merge(catalog, restricted)
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
  privateResponse = false,
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
          HttpServerResponse.jsonUnsafe(
            { code: "market-unavailable", message: "Skill 市场暂不可用" },
            {
              status: 503,
              headers: privateResponse ? { "cache-control": "private, no-store" } : undefined,
            },
          ),
        ),
      onSuccess: ([snapshot, value]) =>
        HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(
            HttpServerResponse.setHeaders(response, {
              "cache-control": privateResponse ? "private, no-store" : "no-cache",
              etag: `"${responseRevision(snapshot.revision, value)}"`,
              "x-skill-market-revision": responseRevision(snapshot.revision, value),
              "x-skill-market-source-skillhub": snapshot.sourceStatus.skillhub,
              "x-skill-market-source-enterprise": snapshot.sourceStatus.enterprise,
              "x-skill-market-source-community": snapshot.sourceStatus.community,
            }),
          ),
        ).pipe(Effect.andThen(Effect.succeed(value))),
    }),
  )
}

function optionalPrincipal(options: Pick<CatalogHttpOptions, "security" | "sessionCookieName">) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const cookies = readCookies(request.headers.cookie)
    return yield* Effect.tryPromise({
      try: () =>
        options.security.requireSession({
          sessionToken: cookies.get(options.sessionCookieName) ?? "",
          csrfToken: cookies.get(options.sessionCookieName.replace(/session$/, "csrf")) ?? "",
        }),
      catch: () => undefined,
    }).pipe(Effect.match({ onFailure: () => undefined, onSuccess: (principal) => principal }))
  })
}

function privateCatalogResponse<A>(
  options: Pick<CatalogHttpOptions, "restrictedCatalog" | "security" | "sessionCookieName">,
  read: (principal: Principal) => Promise<A>,
) {
  return privateHeaders(
    Effect.gen(function* () {
      const principal = yield* optionalPrincipal(options)
      if (!principal)
        return yield* new SkillMarketControlNotFound({
          code: "not-found",
          message: "受限 Skill 不存在",
          requestId: requestID(),
        })
      return yield* Effect.tryPromise({ try: () => read(principal), catch: restrictedProblem })
    }),
  )
}

function privateHeaders<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "private, no-store")),
  ).pipe(Effect.andThen(effect))
}

function restrictedProblem(error: unknown) {
  if (error instanceof SkillMarketSecurityError && error.code === "not-found")
    return new SkillMarketControlNotFound({
      code: "not-found",
      message: "受限 Skill 不存在",
      requestId: requestID(),
    })
  return new SkillMarketDependencyUnavailable({
    code: "dependency-unavailable",
    message: "受限 Skill 暂不可用",
    requestId: requestID(),
  })
}

function responseRevision(fallback: string, value: unknown) {
  if (typeof value !== "object" || value === null || !("revision" in value) || typeof value.revision !== "string")
    return fallback
  return value.revision
}

async function detail(
  catalog: CatalogReader,
  current: Awaited<ReturnType<CatalogReader["index"]>>,
  source: Parameters<CatalogReader["detail"]>[0],
  id: string,
) {
  const value = await catalog.detail(source, id, current)
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
