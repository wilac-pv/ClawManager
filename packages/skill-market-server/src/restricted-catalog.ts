import type { Database } from "bun:sqlite"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import {
  canEmployeeReadRestricted,
  canReadRestricted,
  RestrictedReadConditionSql,
  restrictedReadParameters,
} from "./audience"
import type { MarketDatabase } from "./database"
import type { Principal } from "./security"
import { SkillMarketSecurityError } from "./security"

interface RestrictedPublicationRow {
  readonly id: string
  readonly skill_id: string
  readonly owner_employee_id: string
  readonly owner_display_name: string
  readonly version: string
  readonly scope: "groups" | "department"
  readonly package_key: string
  readonly package_sha256: string
  readonly package_size: number
  readonly metadata_json: string
  readonly manifest_json: string | null
  readonly scan_json: string | null
  readonly created_at: number
  readonly updated_at: number
  readonly reviewed_at: number | null
}

export interface RestrictedPackageIdentity {
  readonly publicationID: string
  readonly employeeID: string
  readonly skillID: string
  readonly version: string
  readonly key: string
  readonly sha256: string
  readonly size: number
}

interface RestrictedCatalogOptions {
  readonly database: MarketDatabase
  readonly apiPublicUrl: string
  readonly now?: () => number
}

export class RestrictedCatalog {
  constructor(private readonly options: RestrictedCatalogOptions) {}

  list(principal: Principal) {
    return this.options.database.read((connection) =>
      connection
        .query<RestrictedPublicationRow, [number, string, string, string]>(
          `${publicationSql()}
           WHERE restricted_publications.status = 'published'
             AND ${RestrictedReadConditionSql}
           ORDER BY restricted_publications.id`,
        )
        .all(...restrictedReadParameters(principal))
        .map((row) => summary(row, this.options.apiPublicUrl)),
    )
  }

  require(principal: Principal, publicationID: string) {
    return this.options.database.read((connection) => {
      if (!canReadRestricted(connection, principal, publicationID)) throw notFound()
      return requireRow(connection, publicationID)
    })
  }

  detail(principal: Principal, publicationID: string) {
    const publication = this.require(principal, publicationID)
    return detail(
      publication,
      this.versionsFor(principal, publication.owner_employee_id, publication.skill_id),
      this.options.apiPublicUrl,
    )
  }

  versions(principal: Principal, publicationID: string) {
    const publication = this.require(principal, publicationID)
    return this.versionsFor(principal, publication.owner_employee_id, publication.skill_id)
  }

  requireEmployee(employeeID: string, publicationID: string): RestrictedPackageIdentity {
    return this.options.database.read((connection) => {
      if (!canEmployeeReadRestricted(connection, employeeID, publicationID)) throw notFound()
      const publication = requireRow(connection, publicationID)
      return {
        publicationID: publication.id,
        employeeID,
        skillID: publication.skill_id,
        version: publication.version,
        key: publication.package_key,
        sha256: publication.package_sha256,
        size: publication.package_size,
      }
    })
  }

  private versionsFor(principal: Principal, ownerEmployeeID: string, skillID: string) {
    return this.options.database.read((connection) =>
      connection
        .query<
          Pick<RestrictedPublicationRow, "version" | "package_sha256" | "package_size" | "created_at">,
          [string, string, number, string, string, string]
        >(
          `SELECT
             restricted_publications.version,
             restricted_publications.package_sha256,
             restricted_publications.package_size,
             restricted_publications.created_at
           FROM restricted_publications
           WHERE restricted_publications.owner_employee_id = ?
             AND restricted_publications.skill_id = ?
             AND restricted_publications.status = 'published'
             AND ${RestrictedReadConditionSql}
           ORDER BY restricted_publications.created_at DESC, restricted_publications.id DESC`,
        )
        .all(ownerEmployeeID, skillID, ...restrictedReadParameters(principal))
        .map(version),
    )
  }
}

export function createRestrictedCatalog(options: RestrictedCatalogOptions) {
  return new RestrictedCatalog(options)
}

function publicationSql() {
  return `SELECT
    restricted_publications.id,
    restricted_publications.skill_id,
    restricted_publications.owner_employee_id,
    users.display_name AS owner_display_name,
    restricted_publications.version,
    restricted_publications.scope,
    restricted_publications.package_key,
    restricted_publications.package_sha256,
    restricted_publications.package_size,
    restricted_publications.metadata_json,
    submission_revisions.manifest_json,
    submission_revisions.scan_json,
    restricted_publications.created_at,
    restricted_publications.updated_at,
    (
      SELECT max(reviews.created_at)
      FROM reviews
      WHERE reviews.submission_id = restricted_publications.submission_id
        AND reviews.decision = 'approved'
    ) AS reviewed_at
   FROM restricted_publications
   INNER JOIN users ON users.employee_id = restricted_publications.owner_employee_id
   INNER JOIN submissions ON submissions.id = restricted_publications.submission_id
   INNER JOIN submission_revisions
     ON submission_revisions.submission_id = submissions.id
    AND submission_revisions.revision_number = submissions.current_revision`
}

function requireRow(connection: Database, publicationID: string) {
  const row = connection
    .query<RestrictedPublicationRow, [string]>(
      `${publicationSql()}
       WHERE restricted_publications.id = ? AND restricted_publications.status = 'published'`,
    )
    .get(publicationID)
  if (!row) throw notFound()
  return row
}

function summary(row: RestrictedPublicationRow, apiPublicUrl: string): SkillMarket.RestrictedSummary {
  const metadata = decodeJson(SkillMarketControl.SubmissionMetadata, row.metadata_json)
  const scan = row.scan_json ? decodeJson(SkillMarketControl.ScanReport, row.scan_json) : undefined
  return {
    id: row.id,
    source: "restricted",
    sourceUrl: new URL(`/v1/restricted-skills/${row.id}`, apiPublicUrl).href,
    name: metadata.displayName,
    description: metadata.description,
    categories: [metadata.category],
    tags: metadata.tags,
    requiresApiKey: metadata.requiresApiKey,
    risk: scan?.risk ?? "unknown",
    version: row.version,
    updatedAt: timestamp(row.updated_at),
    downloads: 0,
    favorites: 0,
    score: 0,
    featured: false,
    enterprise: true,
    visibility: row.scope,
    delisted: false,
    submittedBy: { displayName: row.owner_display_name },
    ...(row.reviewed_at === null ? {} : { reviewedAt: timestamp(row.reviewed_at) }),
    ...(scan ? { reviewRisk: scan.risk } : {}),
  }
}

function detail(
  row: RestrictedPublicationRow,
  versions: ReadonlyArray<SkillMarket.Version>,
  apiPublicUrl: string,
): SkillMarket.RestrictedDetail {
  const metadata = decodeJson(SkillMarketControl.SubmissionMetadata, row.metadata_json)
  const manifest = row.manifest_json ? decodeJson(SkillMarketControl.Manifest, row.manifest_json) : undefined
  const scan = row.scan_json ? decodeJson(SkillMarketControl.ScanReport, row.scan_json) : undefined
  return {
    ...summary(row, apiPublicUrl),
    readme: `# ${metadata.displayName}\n\n${metadata.description}`,
    license: metadata.license,
    author: { name: row.owner_display_name },
    versions: [...versions],
    securityReports: [],
    ...(scan?.reasons.length ? { riskReason: scan.reasons.join("\n") } : {}),
    package: {
      url: new URL(`/v1/restricted-skills/${row.id}/install-grants`, apiPublicUrl).href,
      sha256: row.package_sha256,
      size: row.package_size,
      files: manifest?.files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })) ?? [],
    },
    publicDetailUrl: new URL(`/v1/restricted-skills/${row.id}`, apiPublicUrl).href,
  }
}

function version(
  row: Pick<RestrictedPublicationRow, "version" | "package_sha256" | "package_size" | "created_at">,
): SkillMarket.Version {
  return {
    version: row.version,
    publishedAt: timestamp(row.created_at),
    sha256: row.package_sha256,
    size: row.package_size,
  }
}

function decodeJson<S extends Schema.Decoder<unknown>>(schema: S, value: string): S["Type"] {
  return Schema.decodeUnknownSync(schema)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value))
}

function timestamp(value: number) {
  return new Date(value).toISOString()
}

function notFound() {
  return new SkillMarketSecurityError("not-found", "restricted publication was not found")
}
