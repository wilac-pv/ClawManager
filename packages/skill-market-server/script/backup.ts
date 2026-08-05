import { Database } from "bun:sqlite"
import { chmod, mkdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"

export interface BackupObjectStore {
  readonly putPrivate: (
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
    metadata?: Readonly<Record<string, string>>,
  ) => Promise<void>
}

export interface BackupDatabaseOptions {
  readonly databasePath: string
  readonly backupDirectory: string
  readonly privatePrefix: string
  readonly store: BackupObjectStore
  readonly now?: Date
  readonly zstdExecutable?: string
}

export async function backupDatabase(options: BackupDatabaseOptions) {
  const prefix = normalizePrefix(options.privatePrefix)
  const now = options.now ?? new Date()
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  const nonce = crypto.randomUUID()
  await mkdir(options.backupDirectory, { recursive: true, mode: 0o700 })
  const databaseCopy = join(options.backupDirectory, `.${timestamp}-${nonce}.db.tmp`)
  const compressedCopy = `${databaseCopy}.zst.tmp`

  const source = new Database(options.databasePath, { create: false, readwrite: true })
  const userVersion = source.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
  try {
    source.query("VACUUM INTO ?").run(databaseCopy)
  } finally {
    source.close()
  }

  try {
    await chmod(databaseCopy, 0o600)
    verifyDatabase(databaseCopy)
    await compress(options.zstdExecutable ?? "zstd", databaseCopy, compressedCopy)
    await chmod(compressedCopy, 0o600)
    const bytes = new Uint8Array(await Bun.file(compressedCopy).arrayBuffer())
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    const filename = `${timestamp}-v${userVersion}-${sha256}.db.zst`
    const artifactPath = join(options.backupDirectory, filename)
    const key = `${prefix}/backups/sqlite/${filename}`
    await rename(compressedCopy, artifactPath)
    await options.store
      .putPrivate(key, fileChunks(artifactPath), "application/zstd", { sha256, "user-version": String(userVersion) })
      .then(undefined, () => {
        throw new Error("backup upload failed")
      })
    return { artifactPath, key, sha256, userVersion }
  } finally {
    await Promise.all([rm(databaseCopy, { force: true }), rm(compressedCopy, { force: true })])
  }
}

function verifyDatabase(path: string) {
  const database = new Database(path, { create: false, readonly: true, strict: true })
  try {
    const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check
    if (integrity !== "ok") throw new Error("backup integrity check failed")
    if (database.query<{ foreign_key_check: string }, []>("PRAGMA foreign_key_check").get())
      throw new Error("backup foreign key check failed")
    verifyScopedSharingSchema(database)
  } finally {
    database.close()
  }
}

function verifyScopedSharingSchema(database: Database) {
  const requiredTables = [
    "market_groups",
    "market_group_members",
    "submission_group_targets",
    "restricted_publications",
    "restricted_publication_groups",
    "private_install_grants",
  ]
  const requiredIndexes = [
    "market_group_members_employee",
    "submission_group_targets_group",
    "restricted_publications_owner",
    "restricted_publications_department",
    "restricted_publications_live_owner_skill_version",
    "restricted_publication_groups_group",
    "private_install_grants_expiry",
    "submissions_active_restricted_skill_version",
    "submissions_active_audience_change_source",
  ]
  const requiredTriggers = [
    "submissions_audience_no_update",
    "submission_group_targets_valid_insert",
    "submission_group_targets_no_update",
    "submission_group_targets_no_delete",
    "submissions_audience_valid_transition",
  ]
  const objects = new Set(
    database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')")
      .all()
      .map((row) => row.name),
  )
  const reviewColumns = new Set(
    database.query<{ name: string }, []>("SELECT name FROM pragma_table_info('reviews')").all().map((row) => row.name),
  )
  if (
    [...requiredTables, ...requiredIndexes, ...requiredTriggers].some((name) => !objects.has(name)) ||
    ["approved_package_key", "approved_package_sha256", "approved_package_size", "approved_metadata_json"].some(
      (name) => !reviewColumns.has(name),
    )
  )
    throw new Error("scoped-sharing backup schema is incomplete")
}

async function compress(executable: string, input: string, output: string) {
  const process = Bun.spawn([executable, "-T1", "-q", input, "-o", output], { stderr: "pipe" })
  if ((await process.exited) !== 0) throw new Error("backup compression failed")
}

async function* fileChunks(path: string) {
  const reader = Bun.file(path).stream().getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}

function normalizePrefix(value: string) {
  const prefix = value.replace(/^\/+|\/+$/g, "")
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("private backup prefix is invalid")
  return prefix
}

if (import.meta.main) {
  const { loadConfig } = await import("../src/config")
  const { makeS3ObjectStore } = await import("../src/oss")
  const config = loadConfig()
  const result = await backupDatabase({
    databasePath: config.databasePath,
    backupDirectory:
      process.env.SKILL_MARKET_OPERATION_BACKUP_DIRECTORY ?? "/var/backups/ruying-skill-market/operations",
    privatePrefix: config.privateOssPrefix,
    store: makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket }),
  })
  console.log(JSON.stringify({ key: result.key, sha256: result.sha256, userVersion: result.userVersion }))
}
