import { SkillMarket } from "@opencode-ai/schema/skill-market"

export type CatalogSnapshot = {
  readonly revision: string
  readonly createdAt: string
  readonly items: SkillMarket.Summary[]
  readonly details: Map<string, SkillMarket.Detail>
  readonly facets: SkillMarket.Facets
  readonly sourceStatus: SkillMarket.SourceStatus
}

export function key(source: SkillMarket.Source, id: string) {
  return `${source}:${id}`
}

export function mergeCatalog(
  verifiedDetails: ReadonlyArray<SkillMarket.Detail>,
  enterprise: SkillMarket.EnterpriseIndex,
  sourceStatus: SkillMarket.SourceStatus = { skillhub: "fresh", enterprise: "fresh" },
): CatalogSnapshot {
  const overrides = new Map(
    enterprise.skills.map((skill) => [key(skill.source, skill.referenceId ?? skill.id), skill] as const),
  )
  const details = verifiedDetails
    .map((detail) => applyEnterprise(detail, overrides.get(key(detail.source, detail.id))))
    .toSorted((left, right) => key(left.source, left.id).localeCompare(key(right.source, right.id)))
  const items = details.map(toSummary)
  const revision = new Bun.CryptoHasher("sha256").update(JSON.stringify(items)).digest("hex")
  const visible = items.filter((item) => !item.delisted)
  const facets = buildFacets(revision, sourceStatus, visible)
  return {
    revision,
    createdAt: new Date().toISOString(),
    items,
    details: new Map(details.map((detail) => [key(detail.source, detail.id), detail])),
    facets,
    sourceStatus,
  }
}

export function queryCatalog(snapshot: CatalogSnapshot, query: SkillMarket.PageQuery): SkillMarket.Page {
  const keyword = query.query?.trim().toLocaleLowerCase()
  const filtered = snapshot.items
    .filter((item) => !item.delisted)
    .filter((item) => !query.source || item.source === query.source)
    .filter((item) => !query.category || item.categories.includes(query.category))
    .filter((item) => query.requiresApiKey === undefined || item.requiresApiKey === query.requiresApiKey)
    .filter((item) => query.featured === undefined || item.featured === query.featured)
    .filter((item) => query.enterprise === undefined || item.enterprise === query.enterprise)
    .filter(
      (item) =>
        !keyword ||
        `${item.name}\n${item.description}\n${item.categories.join(" ")}\n${item.tags.join(" ")}`
          .toLocaleLowerCase()
          .includes(keyword),
    )
  const items = filtered.toSorted(comparator(query.sort))
  const start = (query.page - 1) * query.limit
  return {
    revision: snapshot.revision,
    sourceStatus: snapshot.sourceStatus,
    total: items.length,
    page: query.page,
    limit: query.limit,
    items: items.slice(start, start + query.limit),
  }
}

function applyEnterprise(
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

function toSummary(detail: SkillMarket.Detail): SkillMarket.Summary {
  return {
    id: detail.id,
    source: detail.source,
    sourceUrl: detail.sourceUrl,
    name: detail.name,
    description: detail.description,
    iconUrl: detail.iconUrl,
    categories: detail.categories,
    tags: detail.tags,
    requiresApiKey: detail.requiresApiKey,
    risk: detail.risk,
    version: detail.version,
    updatedAt: detail.updatedAt,
    downloads: detail.downloads,
    favorites: detail.favorites,
    score: detail.score,
    featured: detail.featured,
    enterprise: detail.enterprise,
    delisted: detail.delisted,
    installedVersion: detail.installedVersion,
    updateAvailable: detail.updateAvailable,
  }
}

function buildFacets(
  revision: string,
  sourceStatus: SkillMarket.SourceStatus,
  items: ReadonlyArray<SkillMarket.Summary>,
): SkillMarket.Facets {
  const sourceCounts = new Map<SkillMarket.Source, number>()
  const categoryCounts = new Map<string, number>()
  items.forEach((item) => {
    sourceCounts.set(item.source, (sourceCounts.get(item.source) ?? 0) + 1)
    item.categories.forEach((category) => categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1))
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
      yes: items.filter((item) => item.requiresApiKey).length,
      no: items.filter((item) => !item.requiresApiKey).length,
    },
  }
}

function comparator(sort: SkillMarket.Sort) {
  const number = (left: number, right: number) => right - left
  const stable = (left: SkillMarket.Summary, right: SkillMarket.Summary) =>
    left.name.localeCompare(right.name) || key(left.source, left.id).localeCompare(key(right.source, right.id))
  return (left: SkillMarket.Summary, right: SkillMarket.Summary) => {
    if (sort === "downloads")
      return number(left.downloads, right.downloads) || number(left.score, right.score) || stable(left, right)
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
