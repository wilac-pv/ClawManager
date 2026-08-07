import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { createCatalogIndex, type CatalogIndex, key, queryCatalogIndex } from "./catalog"
import { loadCatalogDetail, loadCatalogIndex, type ObjectStore } from "./oss"
import type { Principal } from "./security"

export interface AdminCatalogState {
  readonly overrides: Map<string, { readonly hidden: boolean; readonly featured?: boolean | null; readonly category?: string | null }>
  readonly hiddenCategories: ReadonlySet<string>
}

export function createCatalogReader(options: {
  readonly store: ObjectStore
  readonly prefix: string
  readonly ttlMilliseconds?: number
  readonly now?: () => number
  readonly restrictedCatalog?: { readonly list: (principal: Principal) => Promise<ReadonlyArray<SkillMarket.Summary>> }
  readonly adminState?: { readonly load: () => Promise<AdminCatalogState> }
}): CatalogReader {
  const ttlMilliseconds = options.ttlMilliseconds ?? 60_000
  const now = options.now ?? Date.now
  let cached: { readonly expiresAt: number; readonly index: CatalogIndex } | undefined
  let loading: Promise<CatalogIndex> | undefined
  let adminCached: { readonly expiresAt: number; readonly state: AdminCatalogState } | undefined
  let adminLoading: Promise<AdminCatalogState> | undefined
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

  const adminState = async (): Promise<AdminCatalogState> => {
    if (!options.adminState) return { overrides: new Map(), hiddenCategories: new Set() }
    if (adminCached && adminCached.expiresAt > now()) return adminCached.state
    if (adminLoading) return adminLoading
    adminLoading = options.adminState.load().then((value) => {
      adminCached = { state: value, expiresAt: now() + ttlMilliseconds }
      return value
    })
    try {
      return await adminLoading
    } finally {
      adminLoading = undefined
    }
  }

  const applyAdminState = (catalog: CatalogIndex, state: AdminCatalogState): CatalogIndex => {
    if (state.overrides.size === 0 && state.hiddenCategories.size === 0) return catalog
    const items = catalog.items
      .map((item) => {
        const override = state.overrides.get(key(item.source, item.id))
        const hidden = override?.hidden ?? false
        const featured = override?.featured ?? item.featured
        const categories = override?.category ? [override.category] : item.categories
        return { ...item, featured, categories, delisted: hidden || item.delisted }
      })
      .filter((item) => !state.hiddenCategories.has(item.categories[0] ?? ""))
    return {
      ...catalog,
      items,
      facets: buildAdminFilteredFacets(catalog.revision, catalog.sourceStatus, items),
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
      const catalog = current ?? (await index())
      const state = await adminState()
      return queryCatalogIndex(applyAdminState(catalog, state), query)
    },
    async facets(current?: CatalogIndex, principal?: Principal) {
      const catalog = current ?? (await index())
      const state = await adminState()
      return applyAdminState(catalog, state).facets
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

function buildAdminFilteredFacets(
  revision: string,
  sourceStatus: SkillMarket.SourceStatus,
  items: ReadonlyArray<SkillMarket.Summary>,
): SkillMarket.Facets {
  const sourceCounts = new Map<SkillMarket.Source, number>()
  const categoryCounts = new Map<string, number>()
  let requiresApiKey = 0
  let doesNotRequireApiKey = 0
  items.forEach((item) => {
    if (item.delisted) return
    sourceCounts.set(item.source, (sourceCounts.get(item.source) ?? 0) + 1)
    item.categories.forEach((category) => categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1))
    if (item.requiresApiKey) {
      requiresApiKey++
      return
    }
    doesNotRequireApiKey++
  })
  return {
    revision,
    sourceStatus,
    sources: Array.from(sourceCounts, ([value, count]) => ({ value, count })).toSorted((left, right) =>
      left.value.localeCompare(right.value),
    ),
    categories: Array.from(categoryCounts, ([value, count]) => ({ value, count })).toSorted(
      (left, right) => right.count - left.count || left.value.localeCompare(right.value),
    ),
    requiresApiKey: {
      yes: requiresApiKey,
      no: doesNotRequireApiKey,
    },
  }
}
