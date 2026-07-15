export * as SkillMarketCatalog from "./catalog"

import path from "node:path"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { SkillMarket } from "@opencode-ai/schema/skill-market"

export type Config = {
  readonly baseUrl?: string
  readonly allowedHosts: ReadonlySet<string>
}

const Cache = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  pages: Schema.Record(Schema.String, SkillMarket.Page),
  facets: SkillMarket.Facets.pipe(Schema.optional),
  details: Schema.Record(Schema.String, SkillMarket.Detail),
})
type Cache = typeof Cache.Type
const decodeCache = Schema.decodeUnknownOption(Schema.fromJsonString(Cache))
const encodeCache = Schema.encodeSync(Schema.fromJsonString(Cache))

export class CatalogError extends Schema.TaggedErrorClass<CatalogError>()("SkillMarketCatalogError", {
  code: Schema.Literals(["network-unavailable", "market-unavailable"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: (query: SkillMarket.PageQuery) => Effect.Effect<SkillMarket.Page, CatalogError>
  readonly facets: () => Effect.Effect<SkillMarket.Facets, CatalogError>
  readonly detail: (key: { source: SkillMarket.Source; id: string }) => Effect.Effect<SkillMarket.Detail, CatalogError>
  readonly revalidate: (key: {
    source: SkillMarket.Source
    id: string
  }) => Effect.Effect<SkillMarket.Detail, CatalogError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillMarketCatalog") {}

function layer(config: Config) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const http = yield* HttpClient.HttpClient
      const cachePath = path.join(global.cache, "skill-market", "catalog.json")
      const content = yield* fs.readFileStringSafe(cachePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      let cache: Cache = content
        ? (decodeCache(content).valueOrUndefined ?? { schemaVersion: 1, pages: {}, details: {} })
        : { schemaVersion: 1, pages: {}, details: {} }
      const writes = Semaphore.makeUnsafe(1)

      const persist = (update: (current: Cache) => Cache) =>
        writes.withPermit(
          Effect.gen(function* () {
            cache = update(cache)
            const temp = `${cachePath}.${crypto.randomUUID()}.tmp`
            yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true })
            yield* fs.writeFileString(temp, encodeCache(cache))
            yield* fs.rename(temp, cachePath)
          }).pipe(Effect.catch((error) => Effect.logWarning("failed to cache Skill market catalog", { error }))),
        )

      const execute = (
        target: URL,
        redirects = 5,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, CatalogError> =>
        Effect.gen(function* () {
          const response = yield* HttpClientRequest.get(target.href).pipe(
            http.execute,
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.mapError(
              () => new CatalogError({ code: "network-unavailable", message: "Skill 市场暂时不可用" }),
            ),
          )
          if (response.status >= 300 && response.status < 400 && response.headers.location) {
            if (redirects === 0) {
              return yield* new CatalogError({ code: "market-unavailable", message: "Skill 市场重定向过多" })
            }
            const next = new URL(response.headers.location, target)
            if (!allowed(config, next)) {
              return yield* new CatalogError({
                code: "market-unavailable",
                message: "Skill 市场重定向域名不受信任",
              })
            }
            return yield* execute(next, redirects - 1)
          }
          if (response.status < 200 || response.status >= 300) {
            return yield* new CatalogError({ code: "network-unavailable", message: "Skill 市场暂时不可用" })
          }
          return response
        })

      const get = <A>(route: string, schema: Schema.Decoder<A, never>) =>
        Effect.gen(function* () {
          const target = remoteUrl(config, route)
          if (target instanceof CatalogError) return yield* target
          const response = yield* execute(target)
          const final = new URL(response.request.url)
          if (!allowed(config, final)) {
            return yield* new CatalogError({ code: "market-unavailable", message: "Skill 市场响应域名不受信任" })
          }
          return yield* HttpClientResponse.schemaBodyJson(schema)(response)
        }).pipe(
          Effect.mapError((error) =>
            error instanceof CatalogError
              ? error
              : new CatalogError({ code: "network-unavailable", message: "Skill 市场暂时不可用" }),
          ),
        )

      const fetchDetail = (key: { source: SkillMarket.Source; id: string }) => {
        const cacheKey = `${key.source}/${key.id}`
        return get(`/v1/catalog/skills/${key.source}/${encodeURIComponent(key.id)}`, SkillMarket.Detail).pipe(
          Effect.flatMap((detail) =>
            validateDetail(config, detail).pipe(
              Effect.tap(() =>
                persist((current) => ({ ...current, details: { ...current.details, [cacheKey]: detail } })),
              ),
              Effect.as(detail),
            ),
          ),
        )
      }

      return Service.of({
        list: Effect.fn("SkillMarketCatalog.list")(function* (query) {
          const key = queryString(query)
          return yield* get(`/v1/catalog/skills?${key}`, SkillMarket.Page).pipe(
            Effect.tap((page) => persist((current) => ({ ...current, pages: { ...current.pages, [key]: page } }))),
            Effect.catch((error) => {
              const page = cache.pages[key]
              return page ? Effect.succeed(stalePage(page)) : Effect.fail(error)
            }),
          )
        }),
        facets: Effect.fn("SkillMarketCatalog.facets")(function* () {
          return yield* get("/v1/catalog/facets", SkillMarket.Facets).pipe(
            Effect.tap((facets) => persist((current) => ({ ...current, facets }))),
            Effect.catch((error) => (cache.facets ? Effect.succeed(staleFacets(cache.facets)) : Effect.fail(error))),
          )
        }),
        detail: Effect.fn("SkillMarketCatalog.detail")(function* (key) {
          const cacheKey = `${key.source}/${key.id}`
          return yield* fetchDetail(key).pipe(
            Effect.catch((error) => {
              const detail = cache.details[cacheKey]
              return detail ? Effect.succeed(detail) : Effect.fail(error)
            }),
          )
        }),
        revalidate: Effect.fn("SkillMarketCatalog.revalidate")(function* (key) {
          return yield* fetchDetail(key)
        }),
      })
    }),
  )
}

export function makeNode(config: Config) {
  return makeGlobalNode({ service: Service, layer: layer(config), deps: [httpClient, FSUtil.node, Global.node] })
}

function environmentConfig(): Config {
  const baseUrl = process.env.RUYING_SKILL_MARKET_API_URL
  const baseHost = baseUrl && URL.canParse(baseUrl) ? new URL(baseUrl).hostname : undefined
  return {
    baseUrl,
    allowedHosts: new Set(
      (process.env.RUYING_SKILL_MARKET_ALLOWED_HOSTS ?? baseHost ?? "")
        .split(",")
        .map((host) => host.trim().toLocaleLowerCase("en-US"))
        .filter(Boolean),
    ),
  }
}

function remoteUrl(config: Config, route: string) {
  if (!config.baseUrl || !URL.canParse(config.baseUrl)) {
    return new CatalogError({ code: "market-unavailable", message: "Skill 市场地址未配置" })
  }
  const base = new URL(config.baseUrl)
  if (!allowed(config, base)) {
    return new CatalogError({ code: "market-unavailable", message: "Skill 市场地址不受信任" })
  }
  return new URL(route, base)
}

function validateDetail(config: Config, detail: SkillMarket.Detail): Effect.Effect<void, CatalogError> {
  const target = new URL(detail.package.url)
  if (allowed(config, target)) return Effect.void
  return Effect.fail(new CatalogError({ code: "market-unavailable", message: "Skill 安装包域名不受信任" }))
}

function allowed(config: Config, url: URL) {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    config.allowedHosts.has(url.hostname.toLocaleLowerCase("en-US"))
  )
}

function queryString(query: SkillMarket.PageQuery) {
  const params = new URLSearchParams({ sort: query.sort, page: String(query.page), limit: String(query.limit) })
  if (query.query !== undefined) params.set("query", query.query)
  if (query.source !== undefined) params.set("source", query.source)
  if (query.category !== undefined) params.set("category", query.category)
  if (query.requiresApiKey !== undefined) params.set("requiresApiKey", String(query.requiresApiKey))
  if (query.featured !== undefined) params.set("featured", String(query.featured))
  if (query.enterprise !== undefined) params.set("enterprise", String(query.enterprise))
  return params.toString()
}

function staleStatus(status: SkillMarket.SourceStatus): SkillMarket.SourceStatus {
  return {
    skillhub: status.skillhub === "fresh" ? "stale" : status.skillhub,
    enterprise: status.enterprise === "fresh" ? "stale" : status.enterprise,
  }
}

function stalePage(page: SkillMarket.Page): SkillMarket.Page {
  return { ...page, sourceStatus: staleStatus(page.sourceStatus) }
}

function staleFacets(facets: SkillMarket.Facets): SkillMarket.Facets {
  return { ...facets, sourceStatus: staleStatus(facets.sourceStatus) }
}

export const node = makeNode(environmentConfig())
