import { Database } from "bun:sqlite"
import { Option, Schema } from "effect"
import { communityIconKey, communityPackageKey } from "../src/community"
import { SqliteDatabase } from "../src/database"
import type { MarketDatabase } from "../src/store"
import { createPersonalTrash } from "../src/personal-trash"
import { randomSecret } from "../src/security"

export interface CleanupObjectStore {
  readonly list: (prefix: string) => Promise<ReadonlyArray<{ readonly key: string; readonly lastModified: Date }>>
  readonly delete: (key: string) => Promise<void>
}

export interface CleanupPrivateObjectsOptions {
  readonly databasePath: string
  readonly privatePrefix: string
  readonly publicPrefix?: string
  readonly store: CleanupObjectStore
  readonly now?: Date
  readonly retentionDays?: number
  readonly limit?: number
  readonly dryRun?: boolean
}

export async function cleanupPrivateObjects(options: CleanupPrivateObjectsOptions) {
  const prefix = normalizePrefix(options.privatePrefix)
  const limit = positiveInteger(options.limit ?? 100)
  const cutoff = (options.now ?? new Date()).getTime() - positiveInteger(options.retentionDays ?? 30) * 86_400_000
  const withdrawnCutoff = (options.now ?? new Date()).getTime() - 7 * 86_400_000
  const database = new Database(options.databasePath, { create: false, readwrite: true, strict: true })
  const marketDatabase = new SqliteDatabase(database)
  const delistPurged =
    !options.dryRun && hasTable(database, "artifact_cleanup_jobs")
      ? await purgeApprovedDelists(
          marketDatabase,
          options.store,
          options.publicPrefix ? normalizePrefix(options.publicPrefix) : undefined,
          (options.now ?? new Date()).getTime(),
          limit,
        ).then(
          (result) => result.purged,
          (error) => {
            database.close()
            throw error
          },
        )
      : []
  const personalPurged =
    !options.dryRun &&
    database
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('submissions')")
      .all()
      .some((column) => column.name === "artifacts_purged_at")
    ? await createPersonalTrash({
        database: marketDatabase,
        store: options.store,
        now: () => (options.now ?? new Date()).getTime(),
      })
        .purgeExpiredPersonal()
        .then(
          (result) => result.purged,
          (error) => {
            database.close()
            throw error
          },
        )
    : []
  const withdrawnArtifacts = hasColumn(database, "submission_revisions", "private_package_key")
    ? database
        .query<WithdrawnArtifactRow, [number, number]>(
          `WITH eligible_submissions AS (
             SELECT id, current_revision
             FROM submissions
             WHERE status = 'withdrawn' AND updated_at <= ? AND withdrawn_artifacts_purged_at IS NULL
             ORDER BY updated_at, id
             LIMIT ?
           )
           SELECT eligible_submissions.id, submission_revisions.revision_number AS current_revision,
                  submission_revisions.private_package_key,
                  submission_revisions.private_icon_json
           FROM eligible_submissions
           INNER JOIN submission_revisions
             ON submission_revisions.submission_id = eligible_submissions.id
           ORDER BY eligible_submissions.id, submission_revisions.revision_number`,
        )
        .all(withdrawnCutoff, limit)
        .map((row) => {
          const icon = row.private_icon_json
            ? Schema.decodeUnknownOption(CleanupIcon)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(row.private_icon_json))
            : Option.none()
          const directory = row.private_package_key.replace(/[^/]+$/, "")
          return {
            id: row.id,
            keys: [
              ...(artifactReferenced(database, row.id, row.current_revision, row.private_package_key)
                ? []
                : [row.private_package_key, `${directory}manifest.json`, `${directory}scan.json`]),
              ...(Option.isSome(icon) && !artifactReferenced(database, row.id, row.current_revision, icon.value.key)
                ? [icon.value.key]
                : []),
            ],
          }
        })
    : []
  const submissions = new Map(
    database
      .query<
        { id: string; status: string; current_revision: number; updated_at: number },
        []
      >("SELECT id, status, current_revision, updated_at FROM submissions")
      .all()
      .map((row) => [row.id, row] as const),
  )
  const revisions = new Map(
    database
      .query<
        { submission_id: string; revision_number: number; created_at: number },
        []
      >("SELECT submission_id, revision_number, created_at FROM submission_revisions")
      .all()
      .map((row) => [`${row.submission_id}:${row.revision_number}`, row] as const),
  )
  database.close()

  const submissionPrefix = `${prefix}/submissions/`
  const backupPrefix = `${prefix}/backups/sqlite/`
  const submissionObjects = await options.store.list(submissionPrefix)
  const backupObjects = await options.store.list(backupPrefix)
  const existingSubmissionKeys = new Set(submissionObjects.map((object) => object.key))
  const withdrawn = options.dryRun
    ? []
    : withdrawnArtifacts
        .map((artifact) => ({ ...artifact, keys: artifact.keys.filter((key) => existingSubmissionKeys.has(key)) }))
        .filter((artifact) => artifact.keys.length > 0)
  if (!options.dryRun) await Promise.all(withdrawn.flatMap((artifact) => artifact.keys).map((key) => options.store.delete(key)))
  const withdrawnPurged =
    !options.dryRun && withdrawnArtifacts.length > 0
      ? markWithdrawnPurged(
          options.databasePath,
          [...new Set(withdrawnArtifacts.map((artifact) => artifact.id))],
          (options.now ?? new Date()).getTime(),
        ).filter((submissionID) => withdrawn.some((artifact) => artifact.id === submissionID))
      : []
  const eligible = [
    ...submissionObjects.filter((object) => {
      if (!object.key.startsWith(submissionPrefix) || object.lastModified.getTime() >= cutoff) return false
      const match = /^submissions\/[^/]+\/(sub_[a-zA-Z0-9_-]{8,64})\/(\d+)\/[^/]+$/.exec(
        object.key.slice(prefix.length + 1),
      )
      if (!match) return false
      const revisionNumber = Number(match[2])
      if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) return false
      const submission = submissions.get(match[1])
      const revision = revisions.get(`${match[1]}:${revisionNumber}`)
      if (!submission || !revision) return true
      if (revisionNumber < submission.current_revision && revision.created_at < cutoff) return true
      return submission.status === "rejected" && submission.updated_at < cutoff
    }),
    ...backupObjects.filter((object) => {
      if (!object.key.startsWith(backupPrefix) || object.lastModified.getTime() >= cutoff) return false
      return /^\d{8}T\d{6}Z-v\d+-[a-f0-9]{64}\.db\.zst$/.test(object.key.slice(backupPrefix.length))
    }),
  ]
    .map((object) => object.key)
    .sort()
  const deleted = eligible.slice(0, limit)
  if (!options.dryRun) await Promise.all(deleted.map((key) => options.store.delete(key)))
  return {
    deleted,
    truncated: eligible.length > limit,
    personalPurged,
    delistPurged,
    withdrawnPurged,
  }
}

const CleanupIcon = Schema.Struct({
  key: Schema.String,
  sha256: Schema.String,
  mime: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
})

interface CleanupJobRow {
  readonly id: string
  readonly submission_id: string
  readonly delist_request_id: string
  readonly request_status: string
  readonly target_scope: "company" | "personal" | "groups" | "department"
  readonly current_revision: number
  readonly skill_id: string
  readonly target_version: string
  readonly private_package_key: string
  readonly package_sha256: string
  readonly private_icon_json: string | null
}

interface WithdrawnArtifactRow {
  readonly id: string
  readonly current_revision: number
  readonly private_package_key: string
  readonly private_icon_json: string | null
}

async function purgeApprovedDelists(
  database: MarketDatabase,
  store: CleanupObjectStore,
  publicPrefix: string | undefined,
  now: number,
  limit: number,
) {
  const candidates = database.connection
    .query<{ id: string }, [number, number]>(
      `SELECT id FROM artifact_cleanup_jobs
       WHERE status = 'pending' OR (status = 'running' AND lease_expires_at <= ?)
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(now, limit)
  const purged: string[] = []
  for (const candidate of candidates) {
    const token = randomSecret()
    const claimed = database.transaction(
      (connection) =>
        connection.run(
          `UPDATE artifact_cleanup_jobs
           SET status = 'running', lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = ? AND (status = 'pending' OR (status = 'running' AND lease_expires_at <= ?))`,
          [token, now + 5 * 60_000, now, candidate.id, now],
        ).changes === 1,
    )
    if (!claimed) continue
    const job = readCleanupJob(database.connection, candidate.id)
    if (!job || job.request_status !== "approved" || !publicationInvisible(database.connection, job)) {
      releaseCleanupJob(database.connection, candidate.id, token, now)
      continue
    }
    const icon = job.private_icon_json
      ? Schema.decodeUnknownOption(CleanupIcon)(
          Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(job.private_icon_json),
        )
      : Option.none()
    const directory = job.private_package_key.replace(/[^/]+$/, "")
    const privateReferenced = artifactReferenced(
      database.connection,
      job.submission_id,
      job.current_revision,
      job.private_package_key,
    )
    const iconReferenced = Option.isSome(icon)
      ? artifactReferenced(database.connection, job.submission_id, job.current_revision, icon.value.key)
      : true
    const keys = [
      ...(privateReferenced
        ? []
        : [job.private_package_key, `${directory}manifest.json`, `${directory}scan.json`]),
      ...(Option.isSome(icon) && !iconReferenced ? [icon.value.key] : []),
      ...(job.target_scope === "company"
        ? [
            communityPackageKey(requirePublicPrefix(publicPrefix), job.skill_id, job.target_version, job.package_sha256),
            ...(Option.isSome(icon) && !iconReferenced
              ? [communityIconKey(requirePublicPrefix(publicPrefix), icon.value.sha256, icon.value.mime)]
              : []),
          ]
        : []),
    ]
    const deleted = await Promise.all([...new Set(keys)].map((key) => store.delete(key))).then(
      () => true,
      () => false,
    )
    if (!deleted) {
      releaseCleanupJob(database.connection, candidate.id, token, now)
      continue
    }
    const completed = database.transaction((connection) => {
      const current = readCleanupJob(connection, candidate.id)
      if (!current || current.request_status !== "approved" || !publicationInvisible(connection, current)) return false
      return (
        connection.run(
          `UPDATE artifact_cleanup_jobs
           SET status = 'completed', lease_token = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_token = ?`,
          [now, now, candidate.id, token],
        ).changes === 1
      )
    })
    if (completed) purged.push(job.submission_id)
  }
  return { purged }
}

function readCleanupJob(connection: Database, jobID: string) {
  return connection
    .query<CleanupJobRow, [string]>(
      `SELECT
        artifact_cleanup_jobs.id,
        artifact_cleanup_jobs.submission_id,
        artifact_cleanup_jobs.delist_request_id,
        delist_requests.status AS request_status,
        submissions.target_scope,
        submissions.current_revision,
        submissions.skill_id,
        submissions.target_version,
        submission_revisions.private_package_key,
        submission_revisions.package_sha256,
        submission_revisions.private_icon_json
       FROM artifact_cleanup_jobs
       INNER JOIN delist_requests ON delist_requests.id = artifact_cleanup_jobs.delist_request_id
       INNER JOIN submissions ON submissions.id = artifact_cleanup_jobs.submission_id
       INNER JOIN submission_revisions
         ON submission_revisions.submission_id = submissions.id
        AND submission_revisions.revision_number = submissions.current_revision
       WHERE artifact_cleanup_jobs.id = ? AND artifact_cleanup_jobs.status = 'running'`,
    )
    .get(jobID)
}

function publicationInvisible(connection: Database, job: CleanupJobRow) {
  if (job.target_scope === "personal") return true
  if (job.target_scope === "company")
    return Boolean(
      connection
        .query<{ hidden: number }, [string]>(
          `SELECT 1 AS hidden FROM community_skills
           WHERE current_submission_id = ? AND public_status = 'delisted'`,
        )
        .get(job.submission_id),
    )
  return Boolean(
    connection
      .query<{ hidden: number }, [string]>(
        `SELECT 1 AS hidden FROM restricted_publications
         WHERE submission_id = ? AND status = 'delisted'`,
      )
      .get(job.submission_id),
  )
}

function artifactReferenced(connection: Database, submissionID: string, revision: number, key: string) {
  const revisions = connection
    .query<{ count: number }, [string, number, string, string]>(
      `SELECT count(*) AS count FROM submission_revisions
       WHERE (submission_id != ? OR revision_number != ?)
         AND (private_package_key = ? OR json_extract(private_icon_json, '$.key') = ?)`,
    )
    .get(submissionID, revision, key, key)!.count
  const publications = connection
    .query<{ count: number }, [string, string]>(
      `SELECT count(*) AS count FROM restricted_publications
       WHERE package_key = ? AND (submission_id != ? OR status != 'delisted')`,
    )
    .get(key, submissionID)!.count
  return revisions > 0 || publications > 0
}

function releaseCleanupJob(connection: Database, jobID: string, token: string, now: number) {
  connection.run(
    `UPDATE artifact_cleanup_jobs
     SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'running' AND lease_token = ?`,
    [now, jobID, token],
  )
}

function requirePublicPrefix(value: string | undefined) {
  if (value) return value
  throw new Error("delist cleanup for company publications requires a public prefix")
}

function hasTable(database: Database, table: string) {
  return Boolean(database.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

function hasColumn(database: Database, table: string, column: string) {
  return database
    .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .some((entry) => entry.name === column)
}

function markWithdrawnPurged(databasePath: string, submissionIDs: ReadonlyArray<string>, now: number) {
  const database = new Database(databasePath, { create: false, readwrite: true, strict: true })
  const purged = database.transaction(() =>
    submissionIDs.filter(
      (submissionID) =>
        database.run(
          `UPDATE submissions SET withdrawn_artifacts_purged_at = ?
           WHERE id = ? AND status = 'withdrawn' AND withdrawn_artifacts_purged_at IS NULL`,
          [now, submissionID],
        ).changes === 1,
    ),
  ).immediate()
  database.close()
  return purged
}

function positiveInteger(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("cleanup limit and retention must be positive integers")
  return value
}

function normalizePrefix(value: string) {
  const prefix = value.replace(/^\/+|\/+$/g, "")
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("private cleanup prefix is invalid")
  return prefix
}

if (import.meta.main) {
  const { loadConfig } = await import("../src/config")
  const { makeS3ObjectStore } = await import("../src/oss")
  const config = loadConfig()
  const result = await cleanupPrivateObjects({
    databasePath: config.databasePath,
    privatePrefix: config.privateOssPrefix,
    publicPrefix: config.ossPrefix,
    store: makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket }),
    dryRun: process.argv.includes("--dry-run"),
  })
  console.log(JSON.stringify(result))
}
