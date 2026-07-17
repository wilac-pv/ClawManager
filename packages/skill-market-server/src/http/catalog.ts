import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { normalizeSkillMarketCatalogQuery } from "@opencode-ai/protocol/groups/skill-market-catalog"
import { Effect } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { CatalogReader } from "../catalog-reader"

export function createCatalogHttp(catalog: CatalogReader) {
  return HttpApiBuilder.group(SkillMarketApi, "skillMarket.catalog", (handlers) =>
    handlers
      .handle("skillMarket.catalog.list", (context) =>
        withCatalog(catalog, () =>
          catalog.list(normalizeSkillMarketCatalogQuery(context.query)),
        ),
      )
      .handle("skillMarket.catalog.facets", () => withCatalog(catalog, () => catalog.facets()))
      .handle("skillMarket.catalog.detail", (context) =>
        withCatalog(catalog, () => detail(catalog, context.params.source, context.params.id)),
      )
      .handle("skillMarket.catalog.versions", (context) =>
        withCatalog(catalog, async () => {
          const value = await detail(catalog, context.params.source, context.params.id)
          return HttpServerResponse.isHttpServerResponse(value) ? value : value.versions
        }),
      )
      .handle("skillMarket.catalog.download", (context) =>
        withCatalog(catalog, async () => {
          const value = await detail(catalog, context.params.source, context.params.id)
          if (HttpServerResponse.isHttpServerResponse(value)) return value
          return { url: value.package.url, sha256: value.package.sha256, size: value.package.size }
        }),
      ),
  )
}

function withCatalog<A>(
  catalog: CatalogReader,
  use: () => Promise<A>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> {
  return Effect.tryPromise({ try: () => Promise.all([catalog.index(), use()]), catch: () => undefined }).pipe(
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

async function detail(catalog: CatalogReader, source: Parameters<CatalogReader["detail"]>[0], id: string) {
  const value = await catalog.detail(source, id)
  if (value && !value.delisted) return value
  return HttpServerResponse.jsonUnsafe({ source, id }, { status: 404 })
}
