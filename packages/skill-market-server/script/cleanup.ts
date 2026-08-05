import { Database } from "bun:sqlite"
import { MarketDatabase } from "../src/database"
import { createPersonalTrash } from "../src/personal-trash"

export interface CleanupObjectStore {
  readonly list: (prefix: string) => Promise<ReadonlyArray<{ readonly key: string; readonly lastModified: Date }>>
  readonly delete: (key: string) => Promise<void>
}

export interface CleanupPrivateObjectsOptions {
  readonly databasePath: string
  readonly privatePrefix: string
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
  const database = new Database(options.databasePath, { create: false, readwrite: true, strict: true })
  const personalPurged =
    !options.dryRun &&
    database
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('submissions')")
      .all()
      .some((column) => column.name === "artifacts_purged_at")
    ? await createPersonalTrash({
        database: new MarketDatabase(database),
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
  return { deleted, truncated: eligible.length > limit, personalPurged }
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
    store: makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket }),
    dryRun: process.argv.includes("--dry-run"),
  })
  console.log(JSON.stringify(result))
}
