import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { type CatalogIndex, key, queryCatalogIndex } from "./catalog"
import { loadCatalogDetail, loadCatalogIndex, type ObjectStore } from "./oss"

export function createCatalogReader(options: {
  readonly store: ObjectStore
  readonly prefix: string
  readonly ttlMilliseconds?: number
}) {
  const ttlMilliseconds = options.ttlMilliseconds ?? 60_000
  let cached: { readonly expiresAt: number; readonly index: CatalogIndex } | undefined
  let loading: Promise<CatalogIndex> | undefined
  const details = new Map<string, SkillMarket.Detail>()
  const pendingDetails = new Map<string, Promise<SkillMarket.Detail | undefined>>()

  const index = async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.index
    if (loading) return loading
    loading = loadCatalogIndex(options.store, { prefix: options.prefix }).then((value) => {
      cached = { index: value, expiresAt: Date.now() + ttlMilliseconds }
      return value
    })
    try {
      return await loading
    } finally {
      loading = undefined
    }
  }

  const detail = async (source: SkillMarket.Source, id: string) => {
    const catalog = await index()
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

  return {
    index,
    async list(query: SkillMarket.PageQuery) {
      return queryCatalogIndex(await index(), query)
    },
    async facets() {
      return (await index()).facets
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
}

export type CatalogReader = ReturnType<typeof createCatalogReader>
