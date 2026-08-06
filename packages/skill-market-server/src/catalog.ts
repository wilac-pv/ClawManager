import { SkillMarket } from "@opencode-ai/schema/skill-market"

export type CatalogSnapshot = {
  readonly revision: string
  readonly createdAt: string
  readonly items: SkillMarket.Summary[]
  readonly details: Map<string, SkillMarket.Detail>
  readonly facets: SkillMarket.Facets
  readonly sourceStatus: SkillMarket.SourceStatus
}

export interface CatalogDetailRef {
  readonly key: string
  readonly sha256: string
  readonly version: SkillMarket.Detail["version"]
}

export interface CatalogIndex {
  readonly revision: string
  readonly createdAt: string
  readonly items: SkillMarket.Summary[]
  readonly details: ReadonlyMap<string, CatalogDetailRef>
  readonly facets: SkillMarket.Facets
  readonly sourceStatus: SkillMarket.SourceStatus
}

export type CatalogDetail = {
  readonly summary: SkillMarket.Summary
  readonly ref: CatalogDetailRef
  readonly detail: SkillMarket.Detail
}
type CatalogEntry = {
  readonly summary: SkillMarket.Summary
  readonly ref: CatalogDetailRef
}

export function key(source: SkillMarket.Source, id: string) {
  return `${source}:${id}`
}

export function mergeCatalog(
  verifiedDetails: ReadonlyArray<SkillMarket.Detail>,
  enterprise: SkillMarket.EnterpriseIndex,
  sourceStatus: SkillMarket.SourceStatus = { skillhub: "fresh", enterprise: "fresh", community: "unavailable" },
): CatalogSnapshot {
  const overrides = new Map(
    enterprise.skills.map((skill) => [key(skill.source, skill.referenceId ?? skill.id), skill] as const),
  )
  const details = verifiedDetails
    .map((detail) =>
      applyEnterprise(
        detail,
        [detail.id, ...(detail.aliases ?? [])].map((id) => overrides.get(key(detail.source, id))).find(Boolean),
      ),
    )
    .toSorted((left, right) => key(left.source, left.id).localeCompare(key(right.source, right.id)))
  if (new Set(details.map((detail) => key(detail.source, detail.id))).size !== details.length)
    throw new Error("duplicate catalog key")
  const items = details.map(toSummary)
  const revision = new Bun.CryptoHasher("sha256").update(JSON.stringify({ details, sourceStatus })).digest("hex")
  const facets = buildFacets(revision, sourceStatus, items)
  return {
    revision,
    createdAt: new Date().toISOString(),
    items,
    details: new Map(details.map((detail) => [key(detail.source, detail.id), detail])),
    facets,
    sourceStatus,
  }
}

export function contentAddressDetail(detail: SkillMarket.Detail): CatalogDetail {
  const body = JSON.stringify(detail)
  const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
  return {
    summary: toSummary(detail),
    ref: { key: `details/${sha256}.json`, sha256, version: detail.version },
    detail,
  }
}

export function createCatalogIndex(input: {
  readonly entries: ReadonlyMap<string, CatalogEntry>
  readonly sourceStatus: SkillMarket.SourceStatus
  readonly createdAt?: string
}): CatalogIndex {
  const entries = Array.from(input.entries.entries()).toSorted(([left], [right]) => left.localeCompare(right))
  const revision = revisionForEntries(entries, input.sourceStatus)
  const items = entries.map(([, entry]) => entry.summary)
  return {
    revision,
    createdAt: input.createdAt ?? new Date().toISOString(),
    items,
    details: new Map(entries.map(([entryKey, entry]) => [entryKey, entry.ref])),
    facets: buildFacets(revision, input.sourceStatus, items),
    sourceStatus: input.sourceStatus,
  }
}

export function patchCatalogIndex(input: {
  readonly index: CatalogIndex
  readonly replacements: ReadonlyMap<string, CatalogEntry>
  readonly sourceStatus: SkillMarket.SourceStatus
  readonly createdAt?: string
}): CatalogIndex {
  for (const [entryKey, replacement] of input.replacements) {
    if (!input.index.details.has(entryKey)) throw new Error(`missing catalog key: ${entryKey}`)
    if (key(replacement.summary.source, replacement.summary.id) !== entryKey)
      throw new Error(`replacement key mismatch: ${entryKey}`)
    if (!/^[a-f0-9]{64}$/.test(replacement.ref.sha256)) throw new Error(`replacement hash is invalid: ${entryKey}`)
    if (replacement.ref.key !== `details/${replacement.ref.sha256}.json`)
      throw new Error(`replacement detail key mismatch: ${entryKey}`)
    if (replacement.ref.version !== replacement.summary.version)
      throw new Error(`replacement version mismatch: ${entryKey}`)
  }
  const entries = input.index.items.map((summary) => {
    const entryKey = key(summary.source, summary.id)
    const replacement = input.replacements.get(entryKey)
    return [
      entryKey,
      replacement ? { summary: replacement.summary, ref: replacement.ref } : { summary, ref: input.index.details.get(entryKey)! },
    ] as const
  })
  const revision = revisionForEntries(entries, input.sourceStatus)
  const items = entries.map(([, entry]) => entry.summary)
  return {
    revision,
    createdAt: input.createdAt ?? new Date().toISOString(),
    items,
    details: new Map(entries.map(([entryKey, entry]) => [entryKey, entry.ref])),
    facets: buildFacets(revision, input.sourceStatus, items),
    sourceStatus: input.sourceStatus,
  }
}

export function queryCatalog(snapshot: CatalogSnapshot, query: SkillMarket.PageQuery): SkillMarket.Page {
  return queryCatalogIndex(
    {
      revision: snapshot.revision,
      createdAt: snapshot.createdAt,
      items: snapshot.items,
      details: new Map(),
      facets: snapshot.facets,
      sourceStatus: snapshot.sourceStatus,
    },
    query,
  )
}

export function queryCatalogIndex(index: CatalogIndex, query: SkillMarket.PageQuery): SkillMarket.Page {
  const keyword = query.query?.trim().toLocaleLowerCase()
  const filtered = index.items
    .filter((item) => !item.delisted)
    .filter((item) => !query.source || item.source === query.source)
    .filter((item) => !query.category || item.categories.includes(query.category))
    .filter((item) => query.requiresApiKey === undefined || item.requiresApiKey === query.requiresApiKey)
    .filter((item) => query.featured === undefined || item.featured === query.featured)
    .filter((item) => query.enterprise === undefined || item.enterprise === query.enterprise)
    .filter(
      (item) =>
        !keyword ||
        `${item.name}\n${item.description}\n${item.categories.join(" ")}\n${item.tags.join(" ")}\n${item.aliases?.join(" ") ?? ""}`
          .toLocaleLowerCase()
          .includes(keyword),
    )
  const items = filtered.toSorted(comparator(query.sort))
  const start = (query.page - 1) * query.limit
  return {
    revision: index.revision,
    sourceStatus: index.sourceStatus,
    total: items.length,
    page: query.page,
    limit: query.limit,
    items: items.slice(start, start + query.limit),
  }
}

export function applyEnterprise(
  detail: SkillMarket.Detail,
  override: SkillMarket.EnterpriseIndex["skills"][number] | undefined,
) {
  if (!override) return detail
  const risk = override.risk && riskRank(override.risk) > riskRank(detail.risk) ? override.risk : detail.risk
  const riskReason = risk === detail.risk ? detail.riskReason : (override.riskReason ?? detail.riskReason)
  return {
    ...detail,
    name: override.name,
    description: override.description,
    categories: [override.category],
    featured: override.featured,
    enterprise: true,
    delisted: override.delisted ?? detail.delisted,
    risk,
    riskReason,
    license: override.license ?? detail.license,
  } satisfies SkillMarket.Detail
}

export function toSummary(detail: SkillMarket.Detail): SkillMarket.Summary {
  return {
    id: detail.id,
    source: detail.source,
    sourceUrl: detail.sourceUrl,
    name: detail.name,
    description: detail.description,
    iconUrl: detail.iconUrl,
    categories: detail.categories,
    tags: detail.tags,
    aliases: detail.aliases,
    requiresApiKey: detail.requiresApiKey,
    risk: detail.risk,
    version: detail.version,
    updatedAt: detail.updatedAt,
    downloads: detail.downloads,
    favorites: detail.favorites,
    score: detail.score,
    evaluationScore: detail.evaluationScore,
    traceEvaluation: detail.traceEvaluation,
    featured: detail.featured,
    enterprise: detail.enterprise,
    delisted: detail.delisted,
    installedVersion: detail.installedVersion,
    updateAvailable: detail.updateAvailable,
    submittedBy: detail.submittedBy,
    reviewedAt: detail.reviewedAt,
    reviewRisk: detail.reviewRisk,
  }
}

function buildFacets(
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

function revisionForEntries(
  entries: ReadonlyArray<readonly [string, CatalogEntry]>,
  sourceStatus: SkillMarket.SourceStatus,
) {
  const hash = new Bun.CryptoHasher("sha256").update('{"entries":[')
  entries.forEach((entry, index) => {
    if (index > 0) hash.update(",")
    hash.update(JSON.stringify(entry))
  })
  return hash.update(`],"sourceStatus":${JSON.stringify(sourceStatus)}}`).digest("hex")
}

function comparator(sort: SkillMarket.Sort) {
  const number = (left: number, right: number) => right - left
  const stable = (left: SkillMarket.Summary, right: SkillMarket.Summary) =>
    left.name.localeCompare(right.name) || key(left.source, left.id).localeCompare(key(right.source, right.id))
  return (left: SkillMarket.Summary, right: SkillMarket.Summary) => {
    if (sort === "downloads")
      return number(left.downloads, right.downloads) || number(left.score, right.score) || stable(left, right)
    if (sort === "favorites")
      return number(left.favorites, right.favorites) || number(left.downloads, right.downloads) || stable(left, right)
    if (sort === "recent") return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || stable(left, right)
    if (sort === "featured")
      return Number(right.featured) - Number(left.featured) || number(left.score, right.score) || stable(left, right)
    if (sort === "trending")
      return number(left.score, right.score) || number(left.downloads, right.downloads) || stable(left, right)
    return number(left.score, right.score) || stable(left, right)
  }
}

function riskRank(risk: SkillMarket.Risk) {
  return { safe: 0, unknown: 1, warning: 2, danger: 3 }[risk]
}
