export * as SkillMarket from "./skill-market"

import { Schema } from "effect"
import { optional } from "./schema"

export const Source = Schema.Literals(["skillhub", "enterprise", "community"])
export type Source = typeof Source.Type

export const Risk = Schema.Literals(["unknown", "safe", "warning", "danger"])
export type Risk = typeof Risk.Type

export const Sort = Schema.Literals(["score", "featured", "trending", "downloads", "recent"])
export type Sort = typeof Sort.Type

export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/))
export const MarketPageUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    const invalid = "market page URL must use HTTPS or private HTTP without credentials"
    if (!URL.canParse(value)) return invalid
    const url = new URL(value)
    if (url.username || url.password) return invalid
    if (url.protocol === "https:") return undefined
    if (url.protocol !== "http:") return invalid
    if (url.hostname === "localhost" || url.hostname === "[::1]") return undefined
    const octets = url.hostname.split(".").map(Number)
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255))
      return invalid
    const first = octets[0]
    const second = octets[1]
    if (first === undefined || second === undefined) return invalid
    if (
      first === 10 ||
      first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
      return undefined
    return invalid
  }),
)
export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
)

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const PageNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100_000))
const PageLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))

export const SecurityReport = Schema.Struct({
  provider: Schema.String,
  verdict: Risk,
  summary: Schema.String,
  reportUrl: HttpsUrl.pipe(optional),
})
export type SecurityReport = typeof SecurityReport.Type

export const Version = Schema.Struct({
  version: Schema.String,
  publishedAt: Timestamp,
  sha256: Sha256,
  size: NonNegative,
})
export type Version = typeof Version.Type

export const Package = Schema.Struct({
  url: HttpsUrl,
  sha256: Sha256,
  size: NonNegative,
  files: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Sha256, size: NonNegative })),
})
export type Package = typeof Package.Type

export const Download = Schema.Struct({ url: HttpsUrl, sha256: Sha256, size: NonNegative })
export type Download = typeof Download.Type

export const Summary = Schema.Struct({
  id: Schema.String,
  source: Source,
  sourceUrl: MarketPageUrl,
  name: Schema.String,
  description: Schema.String,
  iconUrl: HttpsUrl.pipe(optional),
  categories: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  aliases: Schema.Array(Schema.String).pipe(optional),
  requiresApiKey: Schema.Boolean,
  risk: Risk,
  version: Schema.String,
  updatedAt: Timestamp,
  downloads: NonNegative,
  favorites: NonNegative,
  score: Schema.Number,
  featured: Schema.Boolean,
  enterprise: Schema.Boolean,
  delisted: Schema.Boolean,
  installedVersion: Schema.String.pipe(optional),
  updateAvailable: Schema.Boolean.pipe(optional),
  submittedBy: Schema.Struct({ displayName: Schema.String }).pipe(optional),
  reviewedAt: Timestamp.pipe(optional),
  reviewRisk: Risk.pipe(optional),
})
export type Summary = typeof Summary.Type

export const Detail = Schema.Struct({
  ...Summary.fields,
  readme: Schema.String,
  license: Schema.String.pipe(optional),
  author: Schema.Struct({ name: Schema.String, url: HttpsUrl.pipe(optional) }),
  versions: Schema.Array(Version),
  securityReports: Schema.Array(SecurityReport),
  riskReason: Schema.String.pipe(optional),
  package: Package,
  publicDetailUrl: MarketPageUrl,
})
export type Detail = typeof Detail.Type

export const PageQuery = Schema.Struct({
  query: Schema.String.pipe(optional),
  source: Source.pipe(optional),
  category: Schema.String.pipe(optional),
  requiresApiKey: Schema.Boolean.pipe(optional),
  featured: Schema.Boolean.pipe(optional),
  enterprise: Schema.Boolean.pipe(optional),
  sort: Sort,
  page: PageNumber,
  limit: PageLimit,
})
export type PageQuery = typeof PageQuery.Type

export const SourceStatus = Schema.Struct({
  skillhub: Schema.Literals(["fresh", "stale", "unavailable"]),
  enterprise: Schema.Literals(["fresh", "stale", "unavailable"]),
  community: Schema.Literals(["fresh", "stale", "unavailable"]),
})
export type SourceStatus = typeof SourceStatus.Type

export const Page = Schema.Struct({
  revision: Schema.String,
  sourceStatus: SourceStatus,
  total: NonNegative,
  page: Schema.Int,
  limit: Schema.Int,
  items: Schema.Array(Summary),
})
export type Page = typeof Page.Type

export const Facets = Schema.Struct({
  revision: Schema.String,
  sourceStatus: SourceStatus,
  sources: Schema.Array(Schema.Struct({ value: Source, count: NonNegative })),
  categories: Schema.Array(Schema.Struct({ value: Schema.String, count: NonNegative })),
  requiresApiKey: Schema.Struct({ yes: NonNegative, no: NonNegative }),
})
export type Facets = typeof Facets.Type

export const EnterpriseIndex = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  updatedAt: Timestamp,
  skills: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      source: Source,
      referenceId: Schema.String.pipe(optional),
      featured: Schema.Boolean,
      delisted: Schema.Boolean.pipe(optional),
      name: Schema.String,
      description: Schema.String,
      category: Schema.String,
      version: Schema.String,
      risk: Risk.pipe(optional),
      riskReason: Schema.String.pipe(optional),
      license: Schema.String.pipe(optional),
      package: Schema.Struct({ url: HttpsUrl, sha256: Sha256 }).pipe(optional),
    }),
  ),
})
export type EnterpriseIndex = typeof EnterpriseIndex.Type

export const InstallRequest = Schema.Struct({
  source: Source,
  id: Schema.String,
  version: Schema.String,
  sha256: Sha256,
  riskConfirmed: Schema.Boolean.pipe(optional),
})
export type InstallRequest = typeof InstallRequest.Type

export const Installed = Schema.Struct({
  source: Source,
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  installedAt: Timestamp,
  updateAvailable: Schema.Boolean,
  loadState: Schema.Literals(["ready", "refresh-failed"]),
})
export type Installed = typeof Installed.Type

export const OperationResult = Schema.Struct({ installed: Installed, changed: Schema.Boolean })
export type OperationResult = typeof OperationResult.Type
