import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import type { Connection, MarketDatabase } from "./store"
import type { ObjectStore, PrivateObjectStore } from "./oss"
import { validateSubmissionArchive } from "./submission-archive"

interface CommunityOptions {
  readonly store: ObjectStore
  readonly publicPrefix: string
  readonly publicBaseUrl: string
  readonly webBaseUrl: string
}

interface PublishOptions {
  readonly store: PrivateObjectStore
  readonly publicPrefix: string
}

interface CurrentRow {
  readonly skill_id: string
  readonly display_name: string
  readonly target_version: string
  readonly updated_at: number
  readonly reviewed_at: number
  readonly private_package_key: string
  readonly package_sha256: string
  readonly package_size: number
  readonly metadata_json: string
  readonly manifest_json: string
  readonly scan_json: string
  readonly private_icon_json: string | null
}

interface VersionRow {
  readonly skill_id: string
  readonly target_version: string
  readonly package_sha256: string
  readonly package_size: number
  readonly published_at: number
}

interface CandidateRow {
  readonly skill_id: string
  readonly target_version: string
  readonly status: SkillMarketControl.SubmissionStatus
  readonly private_package_key: string
  readonly package_sha256: string
  readonly package_size: number
  readonly metadata_json: string
  readonly manifest_json: string
  readonly private_icon_json: string | null
}

const StoredIcon = Schema.Struct({
  key: Schema.String,
  sha256: SkillMarket.Sha256,
  size: Schema.Int.check(Schema.isGreaterThan(0)),
  mime: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
})

export async function listPublishedCommunity(database: MarketDatabase, options: CommunityOptions) {
  const rows = await database.read(async (connection) => ({
    current: await readCurrent(connection),
    versions: await readVersions(connection),
  }))
  const versions = Map.groupBy(rows.versions, (version) => version.skill_id)
  return Promise.all(rows.current.map((row) => materialize(row, versions.get(row.skill_id) ?? [], options)))
}

export async function materializeCommunitySubmission(
  database: MarketDatabase,
  options: CommunityOptions,
  submissionID: string,
) {
  const rows = await database.read(async (connection) => ({
    current: await connection.get<CurrentRow>(
      `${currentSelect()} WHERE submissions.id = ? AND submissions.status IN ('publishing', 'published')`,
      [submissionID],
    ),
    versions: await readVersions(connection),
  }))
  const current = rows.current
  if (!current) throw new Error("community publication submission is not materializable")
  const versions = rows.versions.filter((version) => version.skill_id === current.skill_id)
  if (!versions.some((version) => version.target_version === current.target_version))
    versions.push({
      skill_id: current.skill_id,
      target_version: current.target_version,
      package_sha256: current.package_sha256,
      package_size: current.package_size,
      published_at: current.updated_at,
    })
  return materialize(current, versions, options)
}

export async function materializePublishedCommunitySkill(
  database: MarketDatabase,
  options: CommunityOptions,
  skillID: string,
) {
  const rows = await database.read(async (connection) => ({
    current: await connection.get<CurrentRow>(
      `${currentSelect()}
      INNER JOIN community_skills
        ON community_skills.current_submission_id = submissions.id
       AND community_skills.current_version = submissions.target_version
      WHERE submissions.skill_id = ?
        AND submissions.status = 'published'
        AND community_skills.public_status = 'published'`,
      [skillID],
    ),
    versions: await readVersions(connection),
  }))
  if (!rows.current) return undefined
  return materialize(rows.current, rows.versions.filter((version) => version.skill_id === skillID), options)
}

export async function publishCommunityObjects(database: MarketDatabase, options: PublishOptions, submissionID: string) {
  const candidate = await database.read((connection) =>
    connection.get<CandidateRow>(
      `SELECT
          submissions.skill_id,
          submissions.target_version,
          submissions.status,
          submission_revisions.private_package_key,
          submission_revisions.package_sha256,
          submission_revisions.package_size,
          submission_revisions.metadata_json,
          submission_revisions.manifest_json,
          submission_revisions.private_icon_json
         FROM submissions
         INNER JOIN submission_revisions
           ON submission_revisions.submission_id = submissions.id
          AND submission_revisions.revision_number = submissions.current_revision
         WHERE submissions.id = ?`,
      [submissionID],
    ),
  )
  if (!candidate) throw new Error("community publication submission was not found")
  if (candidate.status !== "publishing" && candidate.status !== "published")
    throw new Error("community publication submission is not publishable")
  const metadata = decodeJson(SkillMarketControl.SubmissionMetadata, candidate.metadata_json)
  const manifest = decodeJson(SkillMarketControl.Manifest, candidate.manifest_json)
  const source = await options.store.get(candidate.private_package_key)
  assertPackage(source, candidate, metadata, manifest)
  const packageKey = communityPackageKey(
    options.publicPrefix,
    candidate.skill_id,
    candidate.target_version,
    candidate.package_sha256,
  )
  await options.store.copy(
    candidate.private_package_key,
    packageKey,
    "application/zip",
    { sha256: candidate.package_sha256, size: String(candidate.package_size) },
    "public, max-age=31536000, immutable",
  )
  await assertPublishedObject(options.store, packageKey, candidate.package_sha256, candidate.package_size)

  const icon = candidate.private_icon_json ? decodeJson(StoredIcon, candidate.private_icon_json) : undefined
  const iconKey = icon ? communityIconKey(options.publicPrefix, icon.sha256, icon.mime) : undefined
  if (icon && iconKey) {
    const body = await options.store.get(icon.key)
    if (body.byteLength !== icon.size || sha256(body) !== icon.sha256)
      throw new Error("community icon does not match its validated artifact")
    await options.store.copy(
      icon.key,
      iconKey,
      icon.mime,
      { sha256: icon.sha256, size: String(icon.size) },
      "public, max-age=31536000, immutable",
    )
    await assertPublishedObject(options.store, iconKey, icon.sha256, icon.size)
  }
  return { packageKey, ...(iconKey ? { iconKey } : {}) }
}

export function communityPackageKey(prefix: string, skillID: string, version: string, packageSha256: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(skillID)) throw new Error("community Skill ID is invalid")
  if (!Schema.is(SkillMarketControl.SemVer)(version) || !Schema.is(SkillMarket.Sha256)(packageSha256))
    throw new Error("community package identity is invalid")
  return objectKey(prefix, `packages/community/${skillID}/${version}/${packageSha256}.zip`)
}

export function communityIconKey(prefix: string, iconSha256: string, mime: typeof StoredIcon.Type.mime) {
  if (!Schema.is(SkillMarket.Sha256)(iconSha256)) throw new Error("community icon identity is invalid")
  const extension = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  }[mime]
  return objectKey(prefix, `assets/icons/${iconSha256}.${extension}`)
}

async function readCurrent(connection: Connection) {
  return connection.all<CurrentRow>(
    `${currentSelect()}
       INNER JOIN community_skills
         ON community_skills.current_submission_id = submissions.id
        AND community_skills.current_version = submissions.target_version
       WHERE submissions.status = 'published' AND community_skills.public_status = 'published'
       ORDER BY submissions.skill_id`,
  )
}

function currentSelect() {
  return `SELECT
    submissions.skill_id,
    users.display_name,
    submissions.target_version,
    submissions.updated_at,
    reviews.created_at AS reviewed_at,
    submission_revisions.private_package_key,
    submission_revisions.package_sha256,
    submission_revisions.package_size,
    submission_revisions.metadata_json,
    submission_revisions.manifest_json,
    submission_revisions.scan_json,
    submission_revisions.private_icon_json
   FROM submissions
   INNER JOIN submission_revisions
     ON submission_revisions.submission_id = submissions.id
    AND submission_revisions.revision_number = submissions.current_revision
   INNER JOIN users ON users.employee_id = submissions.owner_employee_id
   INNER JOIN reviews
     ON reviews.id = (
       SELECT review.id
       FROM reviews AS review
       WHERE review.submission_id = submissions.id
         AND review.revision_number = submissions.current_revision
         AND review.decision = 'approve'
       ORDER BY review.created_at DESC, review.id DESC
       LIMIT 1
     )`
}

async function readVersions(connection: Connection) {
  return connection.all<VersionRow>(
    `SELECT
        submissions.skill_id,
        submissions.target_version,
        submission_revisions.package_sha256,
        submission_revisions.package_size,
        submissions.updated_at AS published_at
       FROM submissions
       INNER JOIN community_skills ON community_skills.skill_id = submissions.skill_id
       INNER JOIN submission_revisions
         ON submission_revisions.submission_id = submissions.id
        AND submission_revisions.revision_number = submissions.current_revision
       WHERE submissions.status = 'published'
       ORDER BY submissions.skill_id, submissions.updated_at, submissions.id`,
  )
}

async function materialize(row: CurrentRow, versions: ReadonlyArray<VersionRow>, options: CommunityOptions) {
  const metadata = decodeJson(SkillMarketControl.SubmissionMetadata, row.metadata_json)
  const manifest = decodeJson(SkillMarketControl.Manifest, row.manifest_json)
  const scan = decodeJson(SkillMarketControl.ScanReport, row.scan_json)
  const packageKey = communityPackageKey(options.publicPrefix, row.skill_id, row.target_version, row.package_sha256)
  const archive = await verifiedPackage(options.store, packageKey, row, metadata, manifest)
  const iconUrl = row.private_icon_json
    ? await verifiedIcon(options, decodeJson(StoredIcon, row.private_icon_json))
    : undefined
  const reason = scan.reasons.join("; ")
  return Schema.decodeUnknownPromise(SkillMarket.Detail)({
    id: row.skill_id,
    source: "community",
    sourceUrl: webUrl(options.webBaseUrl, row.skill_id),
    name: metadata.displayName,
    description: metadata.description,
    ...(iconUrl ? { iconUrl } : {}),
    categories: [metadata.category],
    tags: metadata.tags,
    requiresApiKey: metadata.requiresApiKey,
    risk: scan.risk,
    version: row.target_version,
    updatedAt: timestamp(row.updated_at),
    downloads: 0,
    favorites: 0,
    score: 0,
    featured: false,
    enterprise: false,
    delisted: false,
    submittedBy: { displayName: row.display_name },
    reviewedAt: timestamp(row.reviewed_at),
    reviewRisk: scan.risk,
    readme: archive.readme,
    ...(metadata.license ? { license: metadata.license } : {}),
    author: { name: row.display_name },
    versions: versions.map((version) => ({
      version: version.target_version,
      publishedAt: timestamp(version.published_at),
      sha256: version.package_sha256,
      size: version.package_size,
    })),
    securityReports: reason ? [{ provider: "Ruying Static Scan", verdict: scan.risk, summary: reason }] : [],
    ...(reason ? { riskReason: reason } : {}),
    package: {
      url: publicUrl(options.publicBaseUrl, packageKey, options.publicPrefix),
      sha256: row.package_sha256,
      size: row.package_size,
      files: manifest.files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
    },
    publicDetailUrl: webUrl(options.webBaseUrl, row.skill_id),
  })
}

async function verifiedPackage(
  store: ObjectStore,
  key: string,
  row: Pick<CurrentRow, "package_sha256" | "package_size">,
  metadata: SkillMarketControl.SubmissionMetadata,
  manifest: SkillMarketControl.Manifest,
) {
  const [head, body] = await Promise.all([store.head(key), store.get(key)])
  if (
    head.size !== row.package_size ||
    body.byteLength !== row.package_size ||
    head.metadata?.sha256 !== row.package_sha256 ||
    sha256(body) !== row.package_sha256
  )
    throw new Error("community package does not match its immutable object")
  const archive = validateSubmissionArchive(body, metadata)
  assertManifest(archive.manifest, manifest)
  return archive
}

async function verifiedIcon(options: CommunityOptions, icon: typeof StoredIcon.Type) {
  const key = communityIconKey(options.publicPrefix, icon.sha256, icon.mime)
  const head = await options.store.head(key)
  if (head.size !== icon.size || head.metadata?.sha256 !== icon.sha256)
    throw new Error("community icon does not match its immutable object")
  return publicUrl(options.publicBaseUrl, key, options.publicPrefix)
}

function assertPackage(
  body: Uint8Array,
  candidate: Pick<CandidateRow, "skill_id" | "package_sha256" | "package_size">,
  metadata: SkillMarketControl.SubmissionMetadata,
  manifest: SkillMarketControl.Manifest,
) {
  if (body.byteLength !== candidate.package_size || sha256(body) !== candidate.package_sha256)
    throw new Error("community package does not match its quarantine artifact")
  const validation = validateSubmissionArchive(body, metadata)
  if (validation.skillID !== candidate.skill_id) throw new Error("community package Skill ID does not match")
  assertManifest(validation.manifest, manifest)
}

function assertManifest(actual: SkillMarketControl.Manifest, expected: SkillMarketControl.Manifest) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("community package manifest does not match canonical validation")
}

async function assertPublishedObject(store: ObjectStore, key: string, expectedSha256: string, expectedSize: number) {
  const head = await store.head(key)
  if (head.size !== expectedSize || head.metadata?.sha256 !== expectedSha256)
    throw new Error("community published object verification failed")
}

function decodeJson<S extends Schema.Decoder<unknown>>(schema: S, value: string): S["Type"] {
  return Schema.decodeUnknownSync(schema)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value))
}

function objectKey(prefix: string, suffix: string) {
  const normalized = prefix.replace(/^\/+|\/+$/g, "")
  if (normalized.split("/").some((part) => part === "." || part === "..")) throw new Error("OSS prefix is invalid")
  return normalized ? `${normalized}/${suffix}` : suffix
}

function publicUrl(base: string, key: string, prefix: string) {
  const normalized = prefix.replace(/^\/+|\/+$/g, "")
  const relative = normalized && key.startsWith(`${normalized}/`) ? key.slice(normalized.length + 1) : key
  return new URL(relative, base.endsWith("/") ? base : `${base}/`).href
}

function webUrl(base: string, skillID: string) {
  return new URL(`skills/community/${encodeURIComponent(skillID)}`, base.endsWith("/") ? base : `${base}/`).href
}

function sha256(body: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex")
}

function timestamp(value: number) {
  return new Date(value).toISOString()
}
