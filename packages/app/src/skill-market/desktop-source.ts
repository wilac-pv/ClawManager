import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { SkillMarketActions, SkillMarketDataSource } from "./types"

export const marketLocalErrorCodes = [
  "network-unavailable",
  "market-unavailable",
  "skill-delisted",
  "risk-confirmation-required",
  "hash-mismatch",
  "unsafe-archive",
  "archive-limit",
  "invalid-skill",
  "disk-unavailable",
  "version-conflict",
  "not-market-owned",
  "refresh-failed",
] as const

export type MarketLocalErrorCode = (typeof marketLocalErrorCodes)[number]

export class MarketLocalError extends Error {
  override readonly name = "MarketLocalError"

  constructor(
    readonly code: MarketLocalErrorCode,
    message: string,
  ) {
    super(message)
  }

  static from(error: unknown) {
    if (isMarketError(error)) return new MarketLocalError(error.code, error.message)
    return new MarketLocalError("market-unavailable", "Skill market is unavailable")
  }
}

export function createDesktopSkillMarket(client: OpencodeClient) {
  const market = client.server.skillMarket.skillMarket
  const data = <A>(request: PromiseLike<{ data?: unknown; error?: unknown }>) =>
    Promise.resolve(request).then(
      (result) => {
        if (result.error !== undefined) throw MarketLocalError.from(result.error)
        if (result.data === undefined) throw new MarketLocalError("market-unavailable", "Skill market returned no data")
        return result.data as A
      },
      (error) => Promise.reject(MarketLocalError.from(error)),
    )
  const done = (request: PromiseLike<{ error?: unknown }>) =>
    Promise.resolve(request).then(
      (result) => {
        if (result.error !== undefined) throw MarketLocalError.from(result.error)
      },
      (error) => Promise.reject(MarketLocalError.from(error)),
    )

  return {
    source: {
      list: (query: SkillMarket.PageQuery, signal?: AbortSignal) =>
        data<SkillMarket.Page>(
          market.list(
            {
              ...query,
              source: query.source === undefined ? undefined : requirePublicSource(query.source),
              requiresApiKey: booleanQuery(query.requiresApiKey),
              featured: booleanQuery(query.featured),
              enterprise: booleanQuery(query.enterprise),
              page: String(query.page),
              limit: String(query.limit),
            },
            { signal },
          ),
        ),
      facets: (signal?: AbortSignal) => data<SkillMarket.Facets>(market.facets({ signal })),
      detail: (key, signal?: AbortSignal) =>
        data<SkillMarket.Detail>(market.detail({ ...key, source: requirePublicSource(key.source) }, { signal })),
      versions: (key, signal?: AbortSignal) =>
        data<SkillMarket.Detail>(
          market.detail({ ...key, source: requirePublicSource(key.source) }, { signal }),
        ).then((detail) => detail.versions),
      installed: (signal?: AbortSignal) => data<readonly SkillMarket.Installed[]>(market.installed({ signal })),
      updates: (signal?: AbortSignal) => data<readonly SkillMarket.Installed[]>(market.updates({ signal })),
    } satisfies SkillMarketDataSource,
    actions: {
      kind: "desktop",
      install: (input) =>
        data<SkillMarket.OperationResult>(market.install({ ...input, source: requirePublicSource(input.source) })),
      update: (input) =>
        data<SkillMarket.OperationResult>(market.update({ ...input, source: requirePublicSource(input.source) })),
      uninstall: (key) => done(market.uninstall({ ...key, source: requirePublicSource(key.source) })),
      refresh: (key) => done(market.refresh({ ...key, source: requirePublicSource(key.source) })),
    } satisfies SkillMarketActions,
  }
}

function booleanQuery(value?: boolean) {
  if (value === undefined) return
  return value ? ("true" as const) : ("false" as const)
}

function requirePublicSource(source: SkillMarket.Source): SkillMarket.PublicSource {
  if (source === "restricted") throw new MarketLocalError("market-unavailable", "Restricted Skills require Web access")
  return source
}

function isMarketError(error: unknown): error is { code: MarketLocalErrorCode; message: string } {
  if (error === null || typeof error !== "object") return false
  if (!("code" in error) || !("message" in error)) return false
  if (typeof error.message !== "string") return false
  return marketLocalErrorCodes.includes(error.code as MarketLocalErrorCode)
}
