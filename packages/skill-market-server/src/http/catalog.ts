import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { normalizeSkillMarketCatalogQuery } from "@opencode-ai/protocol/groups/skill-market-catalog"
import { Effect } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { type CatalogSnapshot, key, queryCatalog } from "../catalog"

type SnapshotLoader = () => Promise<CatalogSnapshot>

export function createCatalogHttp(loadSnapshot: SnapshotLoader) {
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
      ),
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
