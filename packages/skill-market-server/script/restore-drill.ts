import { Database } from "bun:sqlite"
import { chmod, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

export interface RestoreObjectStore {
  readonly list: (prefix: string) => Promise<ReadonlyArray<{ readonly key: string; readonly lastModified: Date }>>
  readonly get: (key: string) => Promise<Uint8Array>
  readonly head: (key: string) => Promise<{
    readonly size: number
    readonly metadata?: Readonly<Record<string, string>>
  }>
}

export interface RestoreDrillOptions {
  readonly privatePrefix: string
  readonly temporaryDirectory: string
  readonly expectedUserVersion: number
  readonly store: RestoreObjectStore
  readonly zstdExecutable?: string
}

export async function restoreDrill(options: RestoreDrillOptions) {
  const prefix = `${normalizePrefix(options.privatePrefix)}/backups/sqlite/`
  const backups = (await options.store.list(prefix))
    .filter((object) => {
      if (!object.key.startsWith(prefix)) return false
      return /^\d{8}T\d{6}Z-v\d+-[a-f0-9]{64}\.db\.zst$/.test(object.key.slice(prefix.length))
    })
    .sort((left, right) => right.lastModified.getTime() - left.lastModified.getTime() || right.key.localeCompare(left.key))
  const backup = backups[0]
  if (!backup) throw new Error("restore backup was not found")

  await mkdir(options.temporaryDirectory, { recursive: true, mode: 0o700 })
  const nonce = crypto.randomUUID()
  const compressed = join(options.temporaryDirectory, `.${nonce}.db.zst`)
  const restored = join(options.temporaryDirectory, `.${nonce}.db`)
  try {
    const [metadata, body] = await Promise.all([options.store.head(backup.key), options.store.get(backup.key)])
    const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
    const identity = /-v(\d+)-([a-f0-9]{64})\.db\.zst$/.exec(backup.key)!
    if (
      metadata.size !== body.byteLength ||
      metadata.metadata?.sha256 !== sha256 ||
      metadata.metadata?.user_version !== identity[1] ||
      identity[2] !== sha256
    )
      throw new Error("restore backup identity mismatch")
    await Bun.write(compressed, body)
    await chmod(compressed, 0o600)
    const process = Bun.spawn([options.zstdExecutable ?? "zstd", "-T1", "-q", "-d", compressed, "-o", restored], {
      stderr: "pipe",
    })
    if ((await process.exited) !== 0) throw new Error("restore decompression failed")
    await chmod(restored, 0o600)
    const userVersion = checkDatabase(restored, options.expectedUserVersion)
    return { key: backup.key, userVersion }
  } finally {
    await Promise.all([rm(compressed, { force: true }), rm(restored, { force: true })])
  }
}

function checkDatabase(path: string, expectedUserVersion: number) {
  try {
    const database = new Database(path, { create: false, readonly: true, strict: true })
    try {
      const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check
      if (integrity !== "ok") throw new Error("restore database check failed")
      if (database.query<{ table: string }, []>("PRAGMA foreign_key_check").get())
        throw new Error("restore foreign key check failed")
      const userVersion = database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
      if (userVersion !== expectedUserVersion) throw new Error("restore schema version mismatch")
      return userVersion
    } finally {
      database.close()
    }
  } catch (error) {
    if (
      error instanceof Error &&
      ["restore database check failed", "restore foreign key check failed", "restore schema version mismatch"].includes(
        error.message,
      )
    )
      throw error
    throw new Error("restore database check failed")
  }
}

function normalizePrefix(value: string) {
  const prefix = value.replace(/^\/+|\/+$/g, "")
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("private restore prefix is invalid")
  return prefix
}

if (import.meta.main) {
  const { loadConfig } = await import("../src/config")
  const { makeS3ObjectStore } = await import("../src/oss")
  const config = loadConfig()
  const live = new Database(config.databasePath, { create: false, readonly: true, strict: true })
  const expectedUserVersion = live.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
  live.close()
  const result = await restoreDrill({
    privatePrefix: config.privateOssPrefix,
    temporaryDirectory: process.env.SKILL_MARKET_RESTORE_DIRECTORY ?? "/var/lib/ruying-skill-market/restore-drill",
    expectedUserVersion,
    store: makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket }),
  })
  console.log(JSON.stringify(result))
}
