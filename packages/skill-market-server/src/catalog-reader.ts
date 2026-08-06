import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { createCatalogIndex, type CatalogIndex, key, queryCatalogIndex } from "./catalog"
import { loadCatalogDetail, loadCatalogIndex, type ObjectStore } from "./oss"
import type { Principal } from "./security"

export function createCatalogReader(options: {
  readonly store: ObjectStore
  readonly prefix: string
  readonly ttlMilliseconds?: number
  readonly now?: () => number
  readonly restrictedCatalog?: { readonly list: (principal: Principal) => Promise<ReadonlyArray<SkillMarket.Summary>> }
}): CatalogReader {
  const ttlMilliseconds = options.ttlMilliseconds ?? 60_000
  const now = options.now ?? Date.now
  let cached: { readonly expiresAt: number; readonly index: CatalogIndex } | undefined
  let loading: Promise<CatalogIndex> | undefined
  const details = new Map<string, SkillMarket.Detail>()
  const pendingDetails = new Map<string, Promise<SkillMarket.Detail | undefined>>()

  const index = async () => {
    if (cached && cached.expiresAt > now()) return cached.index
    if (loading) return loading
    loading = loadCatalogIndex(options.store, { prefix: options.prefix }).then((value) => {
      cached = { index: value, expiresAt: now() + ttlMilliseconds }
      return value
    })
    try {
      return await loading
    } finally {
      loading = undefined
    }
  }

  const detail = async (source: SkillMarket.Source, id: string, current?: CatalogIndex) => {
    const catalog = current ?? (await index())
    const entryKey = `${catalog.revision}:${key(source, id)}`
    const existing = details.get(entryKey)
    if (existing) {
      details.delete(entryKey)
      details.set(entryKey, existing)
      return existing
    }
    const pending = pendingDetails.get(entryKey)
    if (pending) return pending
    const request = loadCatalogDetail(options.store, { prefix: options.prefix }, catalog, source, id).then((value) => {
      if (!value) return undefined
      details.set(entryKey, value)
      if (details.size > 512) details.delete(details.keys().next().value!)
      return value
    })
    pendingDetails.set(entryKey, request)
    try {
      return await request
    } finally {
      pendingDetails.delete(entryKey)
    }
  }

  const reader: CatalogReader = {
    index,
    async list(query: SkillMarket.PageQuery, current?: CatalogIndex, principal?: Principal) {
      return queryCatalogIndex(current ?? (await index()), query)
    },
    async facets(current?: CatalogIndex, principal?: Principal) {
      return (current ?? (await index())).facets
    },
    detail,
    async versions(source: SkillMarket.Source, id: string) {
      return (await detail(source, id))?.versions
    },
    async download(source: SkillMarket.Source, id: string) {
      const value = await detail(source, id)
      if (!value) return undefined
      return { url: value.package.url, sha256: value.package.sha256, size: value.package.size }
    },
  }
  if (!options.restrictedCatalog) return reader
  return authorizeCatalogReader(reader, options.restrictedCatalog)
}

export function authorizeCatalogReader(
  catalog: CatalogReader,
  restrictedCatalog: { readonly list: (principal: Principal) => Promise<ReadonlyArray<SkillMarket.Summary>> },
) {
  return {
    ...catalog,
    async list(query: SkillMarket.PageQuery, current?: CatalogIndex, principal?: Principal) {
      const index = current ?? (await catalog.index())
      if (!principal) return catalog.list(query, index)
      return queryCatalogIndex(combine(index, await restrictedCatalog.list(principal)), query)
    },
    async facets(current?: CatalogIndex, principal?: Principal) {
      const index = current ?? (await catalog.index())
      if (!principal) return catalog.facets(index)
      return combine(index, await restrictedCatalog.list(principal)).facets
    },
  } satisfies CatalogReader
}

function combine(index: CatalogIndex, restricted: ReadonlyArray<SkillMarket.Summary>) {
  if (restricted.length === 0) return index
  const ref = (summary: SkillMarket.Summary) => {
    const sha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(summary)).digest("hex")
    return { key: `restricted/${sha256}.json`, sha256, version: summary.version }
  }
  return createCatalogIndex({
    createdAt: index.createdAt,
    sourceStatus: index.sourceStatus,
    entries: new Map([
      ...index.items.map((summary) => [
        `public:${key(summary.source, summary.id)}`,
        { summary, ref: index.details.get(key(summary.source, summary.id)) ?? ref(summary) },
      ] as const),
      ...restricted.map((summary) => [`restricted:${summary.id}`, { summary, ref: ref(summary) }] as const),
    ]),
  })
}

export interface CatalogReader {
  readonly index: () => Promise<CatalogIndex>
  readonly list: (query: SkillMarket.PageQuery, current?: CatalogIndex, principal?: Principal) => Promise<SkillMarket.Page>
  readonly facets: (current?: CatalogIndex, principal?: Principal) => Promise<SkillMarket.Facets>
  readonly detail: (source: SkillMarket.Source, id: string, current?: CatalogIndex) => Promise<SkillMarket.Detail | undefined>
  readonly versions: (source: SkillMarket.Source, id: string) => Promise<ReadonlyArray<SkillMarket.Version> | undefined>
  readonly download: (source: SkillMarket.Source, id: string) => Promise<SkillMarket.Download | undefined>
}
