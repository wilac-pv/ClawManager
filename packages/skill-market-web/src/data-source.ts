import type { SkillMarketDataSource } from "@opencode-ai/app/skill-market"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"

export class MarketHttpError extends Error {
  constructor(readonly status: number) {
    super(`Skill market request failed with status ${status}`)
    this.name = "MarketHttpError"
  }
}

export type AnnouncementSource = {
  list: (query: { page: number; limit: number }, signal?: AbortSignal) => Promise<SkillMarket.AnnouncementPage>
  detail: (announcementID: string, signal?: AbortSignal) => Promise<SkillMarket.AnnouncementDetail>
}

export function createRemoteSkillMarketDataSource(
  baseUrl: string,
  options: { allowInsecurePrivateHttp?: boolean } = {},
): SkillMarketDataSource & { announcements: AnnouncementSource } {
  const base = requireSecureBaseUrl(baseUrl, options.allowInsecurePrivateHttp)
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
    announcements: {
      list: (query, signal) =>
        get(
          `/v1/catalog/announcements?${withQuery([
            ["page", query.page],
            ["limit", query.limit],
          ])}`,
          SkillMarket.AnnouncementPage,
          signal,
        ),
      detail: (announcementID, signal) =>
        get(
          `/v1/catalog/announcements/${encodeURIComponent(announcementID)}`,
          SkillMarket.AnnouncementDetail,
          signal,
        ),
    },
    expertPackages: {
      list: (query, signal) =>
        get(
          `/v1/catalog/expert-packages?${withQuery([
            ["query", query.query],
            ["scene", query.scene],
            ["page", query.page],
            ["limit", query.limit],
          ])}`,
          SkillMarket.ExpertPackagePage,
          signal,
        ),
      detail: (slug, signal) =>
        get(`/v1/catalog/expert-packages/${encodeURIComponent(slug)}`, SkillMarket.ExpertPackageDetail, signal),
    },
  }
}

function withQuery(entries: ReadonlyArray<readonly [string, string | number | undefined]>) {
  const query = new URLSearchParams()
  entries.forEach(([key, value]) => {
    if (value !== undefined) query.set(key, String(value))
  })
  return query.toString()
}

function requireSecureBaseUrl(value: string, allowInsecurePrivateHttp?: boolean) {
  const url = new URL(value)
  if (url.protocol === "https:") return url
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return url
  if (url.protocol === "http:" && allowInsecurePrivateHttp && privateIpv4(url.hostname)) return url
  throw new Error("Skill market API must use HTTPS outside loopback development")
}

function privateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) return true
  return parts[0] === 192 && parts[1] === 168
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
