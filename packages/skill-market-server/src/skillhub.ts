import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type SkillHubRecord = {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly iconUrl?: string
  readonly categories: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly requiresApiKey: boolean
  readonly risk: SkillMarket.Risk
  readonly riskReason?: string
  readonly version: string
  readonly updatedAt: string
  readonly downloads: number
  readonly favorites: number
  readonly score: number
  readonly sourceUrl: string
  readonly publicDetailUrl: string
  readonly author: { readonly name: string; readonly url?: string }
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string; readonly size: number }>
  readonly versions: ReadonlyArray<{
    readonly version: string
    readonly publishedAt: string
    readonly changelog: string
  }>
  readonly securityReports: ReadonlyArray<SkillMarket.SecurityReport>
  readonly downloadUrl: string
}

const SubCategory = Schema.Struct({ key: Schema.String, name: Schema.String })
const ListSkill = Schema.Struct({
  category: Schema.String,
  description: Schema.String,
  description_zh: Schema.String.pipe(Schema.optional),
  downloads: Schema.Number,
  homepage: Schema.String.pipe(Schema.optional),
  iconUrl: Schema.NullOr(Schema.String).pipe(Schema.optional),
  installs: Schema.Number,
  labels: Schema.NullOr(Schema.Struct({ requires_api_key: Schema.String })).pipe(Schema.optional),
  name: Schema.String,
  ownerName: Schema.String,
  score: Schema.Number,
  slug: Schema.String,
  source: Schema.String,
  stars: Schema.Number,
  subCategories: Schema.Array(SubCategory),
  tags: Schema.NullOr(Schema.Array(Schema.String)).pipe(Schema.optional),
  updated_at: Schema.Number,
  version: Schema.String,
})
const ListResponse = Schema.Struct({
  code: Schema.Number,
  data: Schema.Struct({ skills: Schema.Array(ListSkill), total: Schema.Number }),
  message: Schema.String,
})

const ExternalReport = Schema.Struct({
  reportUrl: Schema.String,
  status: Schema.String,
  statusText: Schema.String,
})
const DetailResponse = Schema.Struct({
  latestVersion: Schema.Struct({ changelog: Schema.String, createdAt: Schema.Number, version: Schema.String }),
  owner: Schema.Struct({ displayName: Schema.String, handle: Schema.String }),
  securityReports: Schema.Record(Schema.String, ExternalReport),
  skill: Schema.Struct({
    category: Schema.String,
    displayName: Schema.String,
    iconUrl: Schema.NullOr(Schema.String).pipe(Schema.optional),
    labels: Schema.NullOr(Schema.Struct({ requires_api_key: Schema.String })).pipe(Schema.optional),
    slug: Schema.String,
    sourceUrl: Schema.NullOr(Schema.String).pipe(Schema.optional),
    stats: Schema.Struct({
      downloads: Schema.Number,
      installs: Schema.Number,
      stars: Schema.Number,
      versions: Schema.Number,
    }),
    subCategories: Schema.Array(SubCategory),
    summary: Schema.String,
    summary_zh: Schema.String.pipe(Schema.optional),
    updatedAt: Schema.Number,
    upstream_url: Schema.NullOr(Schema.String).pipe(Schema.optional),
  }),
})
const FilesResponse = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, sha256: SkillMarket.Sha256, size: Schema.Number })),
  version: Schema.String,
})
const VersionsResponse = Schema.Struct({
  versions: Schema.Array(
    Schema.Struct({
      changelog: Schema.String,
      createdAt: Schema.Number,
      version: Schema.String,
      versionId: Schema.Number,
    }),
  ),
})

export async function loadSkillHub(
  fetcher: Fetcher,
  input: string,
  previous?: ReadonlyMap<string, SkillHubRecord>,
  limit?: number,
): Promise<SkillHubRecord[]> {
  const baseUrl = requireBaseUrl(input)
  const first = await loadPage(fetcher, baseUrl, 1)
  const total = Math.min(first.data.total, limit ?? first.data.total)
  const pages = await Promise.all(
    Array.from({ length: Math.max(0, Math.ceil(total / 100) - 1) }, (_, index) =>
      loadPage(fetcher, baseUrl, index + 2),
    ),
  )
  const skills = Array.from(
    new Map([first, ...pages].flatMap((page) => page.data.skills).map((skill) => [skill.slug, skill])).values(),
  ).slice(0, total)
  const chunks = Array.from({ length: Math.ceil(skills.length / 8) }, (_, index) =>
    skills.slice(index * 8, index * 8 + 8),
  )
  const records: SkillHubRecord[] = []
  for (const chunk of chunks)
    records.push(...(await Promise.all(chunk.map((skill) => loadRecord(fetcher, baseUrl, skill, previous)))))
  return records
}

async function loadPage(fetcher: Fetcher, baseUrl: URL, page: number) {
  const url = new URL("/api/skills", baseUrl)
  url.searchParams.set("page", String(page))
  url.searchParams.set("pageSize", "100")
  url.searchParams.set("sortBy", "score")
  return fetchJson(fetcher, url, ListResponse, baseUrl.hostname)
}

async function loadRecord(
  fetcher: Fetcher,
  baseUrl: URL,
  skill: typeof ListSkill.Type,
  previous: ReadonlyMap<string, SkillHubRecord> | undefined,
) {
  const cached = previous?.get(skill.slug)
  const updatedAt = new Date(skill.updated_at).toISOString()
  if (cached?.version === skill.version && cached.updatedAt === updatedAt) return cached

  const root = new URL(`/api/v1/skills/${encodeURIComponent(skill.slug)}`, baseUrl)
  const filesUrl = new URL(`${root.pathname}/files`, baseUrl)
  filesUrl.searchParams.set("version", skill.version)
  const [detail, files, versions] = await Promise.all([
    fetchJson(fetcher, root, DetailResponse, baseUrl.hostname),
    fetchJson(fetcher, filesUrl, FilesResponse, baseUrl.hostname),
    fetchJson(fetcher, new URL(`${root.pathname}/versions`, baseUrl), VersionsResponse, baseUrl.hostname),
  ])
  const reports = Object.entries(detail.securityReports).map(([provider, report]) => ({
    provider,
    verdict: reportRisk(report.status),
    summary: report.statusText,
    ...(isHttps(report.reportUrl) ? { reportUrl: report.reportUrl } : {}),
  })) satisfies SkillMarket.SecurityReport[]
  const risk = reports.reduce<SkillMarket.Risk>(
    (result, report) => (riskRank(report.verdict) > riskRank(result) ? report.verdict : result),
    "unknown",
  )
  const sourceUrl = [detail.skill.sourceUrl, detail.skill.upstream_url, skill.homepage].find(
    (value) => value && isHttps(value),
  )
  const publicDetailUrl = new URL(`/skills/${encodeURIComponent(skill.slug)}`, "https://skillhub.cn").href
  const downloadUrl = new URL("/api/v1/download", baseUrl)
  downloadUrl.searchParams.set("slug", skill.slug)
  downloadUrl.searchParams.set("version", detail.latestVersion.version)
  const riskReason = reports.find((report) => report.verdict === risk)?.summary
  const iconUrl = detail.skill.iconUrl && isHttps(detail.skill.iconUrl) ? detail.skill.iconUrl : undefined
  return {
    slug: skill.slug,
    name: detail.skill.displayName || skill.name,
    description: detail.skill.summary_zh || detail.skill.summary || skill.description_zh || skill.description,
    ...(iconUrl ? { iconUrl } : {}),
    categories: Array.from(new Set([detail.skill.category, ...detail.skill.subCategories.map((value) => value.name)])),
    tags: skill.tags ?? [],
    requiresApiKey: (detail.skill.labels?.requires_api_key ?? skill.labels?.requires_api_key) === "true",
    risk,
    ...(riskReason ? { riskReason } : {}),
    version: detail.latestVersion.version,
    updatedAt,
    downloads: detail.skill.stats.downloads,
    favorites: detail.skill.stats.stars,
    score: skill.score,
    sourceUrl: sourceUrl ?? publicDetailUrl,
    publicDetailUrl,
    author: { name: detail.owner.displayName || detail.owner.handle },
    files: files.files,
    versions: versions.versions.map((version) => ({
      version: version.version,
      publishedAt: new Date(version.createdAt).toISOString(),
      changelog: version.changelog,
    })),
    securityReports: reports,
    downloadUrl: downloadUrl.href,
  } satisfies SkillHubRecord
}

async function fetchJson<S extends Schema.Decoder<unknown>>(
  fetcher: Fetcher,
  url: URL,
  schema: S,
  allowedHost: string,
) {
  const response = await fetcher(url, { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`SkillHub request failed with ${response.status}: ${url.pathname}`)
  if (response.url) {
    const finalUrl = new URL(response.url)
    if (finalUrl.protocol !== "https:" || finalUrl.hostname !== allowedHost)
      throw new Error("SkillHub redirected outside its API host")
  }
  return Schema.decodeUnknownPromise(schema)(await response.json())
}

function requireBaseUrl(input: string) {
  if (!URL.canParse(input)) throw new Error("SkillHub base URL must be HTTPS")
  const url = new URL(input)
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("SkillHub base URL must be HTTPS")
  return url
}

function isHttps(input: string) {
  return URL.canParse(input) && new URL(input).protocol === "https:"
}

function reportRisk(status: string): SkillMarket.Risk {
  const value = status.toLocaleLowerCase()
  if (["benign", "safe", "clean"].includes(value)) return "safe"
  if (["suspicious", "warning"].includes(value)) return "warning"
  if (["malicious", "danger", "unsafe"].includes(value)) return "danger"
  return "unknown"
}

function riskRank(risk: SkillMarket.Risk) {
  return { safe: 0, unknown: 1, warning: 2, danger: 3 }[risk]
}
