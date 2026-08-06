import { Database } from "bun:sqlite"
import { chmod, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { MarketMetricEmitter } from "./metrics"

// MarketDatabase 现在是 store.ts 的接口;SQLite 实现见 sqlite-driver.ts。
// 保留从这个模块的导出,让现有 `import { MarketDatabase } from "./database"`
// 不需要改 import 路径(只从值导出变为类型导出)。
export type { MarketDatabase } from "./store"
export { SqliteDatabase } from "./sqlite-driver"
import { SqliteDatabase } from "./sqlite-driver"
import { openPostgres } from "./pg-driver"
import type { MarketDatabase } from "./store"

export interface OpenDatabaseOptions {
  readonly databasePath: string
  readonly migrationBackupDirectory: string
  readonly migrationDirectory?: string
  readonly emit?: MarketMetricEmitter
}

/** PG 分流选项;有 url 时走 PG,否则回退 SQLite。 */
export interface MarketDatabaseOptions extends OpenDatabaseOptions {
  readonly postgresUrl?: string
  readonly postgresSchema?: string
}

/**
 * 根据 postgresUrl 是否存在,分流到 PG 或 SQLite。
 * 这是 server/worker/sync 等启动点应该调用的统一入口。
 */
export async function openMarketDatabase(options: MarketDatabaseOptions): Promise<MarketDatabase> {
  if (options.postgresUrl) {
    return openPostgres({
      url: options.postgresUrl,
      schema: options.postgresSchema,
    })
  }
  return openDatabase(options)
}

/**
 * 打开 SQLite 数据库、应用迁移,返回 MarketDatabase 接口。
 * 运行时是 SqliteDatabase(bun:sqlite 实现)。
 */
export async function openDatabase(options: OpenDatabaseOptions): Promise<MarketDatabase> {
  const existed = await Bun.file(options.databasePath).exists()
  await Promise.all([
    mkdir(dirname(options.databasePath), { recursive: true }),
    mkdir(options.migrationBackupDirectory, { recursive: true }),
  ])

  const connection = new Database(options.databasePath, { create: true, readwrite: true })
  return initialize(connection, options, existed).then(
    () => new SqliteDatabase(connection),
    (error) => {
      connection.close()
      throw error
    },
  )
}

async function initialize(connection: Database, options: OpenDatabaseOptions, existed: boolean) {
  connection.run("PRAGMA busy_timeout = 5000")
  connection.run("PRAGMA foreign_keys = ON")
  connection.run("PRAGMA journal_mode = WAL")

  const currentVersion = connection.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
  const migrations = await loadMigrations(
    options.migrationDirectory ?? fileURLToPath(new URL("../migrations/", import.meta.url)),
  )
  if (currentVersion > migrations.length)
    throw new Error(`database user_version ${currentVersion} is newer than available migrations ${migrations.length}`)

  const pending = migrations.slice(currentVersion)
  if (pending.length === 0) return
  if (existed)
    await backupDatabase(connection, options.migrationBackupDirectory, currentVersion, migrations.length).then(
      () => safeEmit(options.emit, { skill_market_database_backup_result: { success: 1 } }),
      async (error: unknown) => {
        await safeEmit(options.emit, { skill_market_database_backup_result: { failure: 1 } })
        throw error
      },
    )

  connection
    .transaction(() => {
      const transactionVersion = connection.query<{ user_version: number }, []>("PRAGMA user_version").get()!
        .user_version
      if (transactionVersion > migrations.length)
        throw new Error(
          `database user_version ${transactionVersion} is newer than available migrations ${migrations.length}`,
        )
      migrations.slice(transactionVersion).forEach((migration) => {
        connection.exec(migration.sql)
        connection.exec(`PRAGMA user_version = ${migration.version}`)
      })
    })
    .exclusive()
  await chmod(options.databasePath, 0o600)
}

async function loadMigrations(directory: string) {
  const files = await Array.fromAsync(new Bun.Glob("*.sql").scan({ cwd: directory }))
  const migrations = await Promise.all(
    files.map(async (file) => {
      const match = /^(\d+)[_-].+\.sql$/.exec(file)
      if (!match) throw new Error(`invalid migration filename: ${file}`)
      return {
        file,
        version: Number(match[1]),
        sql: await Bun.file(join(directory, file)).text(),
      }
    }),
  )
  migrations.sort((left, right) => left.version - right.version || left.file.localeCompare(right.file))
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1)
      throw new Error(`migration versions must be unique and contiguous from 1; found ${migration.file}`)
  })
  return migrations
}

async function backupDatabase(connection: Database, directory: string, fromVersion: number, toVersion: number) {
  const path = join(directory, `market-v${fromVersion}-to-v${toVersion}-${Date.now()}.db`)
  await Bun.write(path, connection.serialize())

  const result = verifyBackup(path)
  await Promise.all(
    [`${path}-wal`, `${path}-shm`].map(async (sidecar) => {
      const file = Bun.file(sidecar)
      if (await file.exists()) await file.delete()
    }),
  )
  await chmod(path, 0o600)
  if (result !== "ok") throw new Error(`migration backup failed integrity_check: ${result ?? "no result"}`)
}

function verifyBackup(path: string) {
  const backup = new Database(path, { create: false, readwrite: true })
  try {
    backup.run("PRAGMA journal_mode = DELETE")
    return backup.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check
  } finally {
    backup.close()
  }
}

function safeEmit(emit: MarketMetricEmitter | undefined, metric: Readonly<Record<string, unknown>>) {
  return Promise.resolve()
    .then(() => emit?.(metric))
    .then(
      () => undefined,
      () => undefined,
    )
}
