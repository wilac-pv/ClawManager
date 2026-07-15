import type { SkillMarketDataSource } from "@opencode-ai/app/skill-market"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"

export class MarketHttpError extends Error {
  constructor(readonly status: number) {
    super(`Skill market request failed with status ${status}`)
    this.name = "MarketHttpError"
  }
}

export function createRemoteSkillMarketDataSource(baseUrl: string): SkillMarketDataSource {
  const base = requireSecureBaseUrl(baseUrl)
  const get = async <S extends Schema.Decoder<unknown>>(path: string, schema: S, signal?: AbortSignal) => {
    const response = await fetch(new URL(path, base), {
      signal,
      headers: { accept: "application/json" },
    })
    if (!response.ok) throw new MarketHttpError(response.status)
    return Schema.decodeUnknownPromise(schema)(await response.json())
  }

  return {
    list: (query, signal) => get(`/v1/catalog/skills?${encodePageQuery(query)}`, SkillMarket.Page, signal),
    facets: (signal) => get("/v1/catalog/facets", SkillMarket.Facets, signal),
    detail: (key, signal) =>
      get(`/v1/catalog/skills/${key.source}/${encodeURIComponent(key.id)}`, SkillMarket.Detail, signal),
    versions: (key, signal) =>
      get(
        `/v1/catalog/skills/${key.source}/${encodeURIComponent(key.id)}/versions`,
        Schema.Array(SkillMarket.Version),
        signal,
      ),
    download: (key, signal) =>
      get(`/v1/catalog/skills/${key.source}/${encodeURIComponent(key.id)}/download`, SkillMarket.Download, signal),
  }
}

function requireSecureBaseUrl(value: string) {
  const url = new URL(value)
  if (url.protocol === "https:") return url
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return url
  throw new Error("Skill market API must use HTTPS outside loopback development")
}

function encodePageQuery(query: SkillMarket.PageQuery) {
  const params = new URLSearchParams()
  if (query.query !== undefined) params.set("query", query.query)
  if (query.source !== undefined) params.set("source", query.source)
  if (query.category !== undefined) params.set("category", query.category)
  if (query.requiresApiKey !== undefined) params.set("requiresApiKey", String(query.requiresApiKey))
  if (query.featured !== undefined) params.set("featured", String(query.featured))
  if (query.enterprise !== undefined) params.set("enterprise", String(query.enterprise))
  params.set("sort", query.sort)
  params.set("page", String(query.page))
  params.set("limit", String(query.limit))
  return params.toString()
}
