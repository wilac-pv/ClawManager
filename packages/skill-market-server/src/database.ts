import { Database } from "bun:sqlite"
import { chmod, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface OpenDatabaseOptions {
  readonly databasePath: string
  readonly migrationBackupDirectory: string
  readonly migrationDirectory?: string
}

export class MarketDatabase {
  constructor(readonly connection: Database) {}

  transaction<T>(callback: (connection: Database) => T) {
    return this.connection.transaction(() => callback(this.connection)).immediate()
  }

  close() {
    this.connection.close()
  }
}

export async function openDatabase(options: OpenDatabaseOptions) {
  const existed = await Bun.file(options.databasePath).exists()
  await Promise.all([
    mkdir(dirname(options.databasePath), { recursive: true }),
    mkdir(options.migrationBackupDirectory, { recursive: true }),
  ])

  const connection = new Database(options.databasePath, { create: true, readwrite: true })
  return initialize(connection, options, existed).then(
    () => new MarketDatabase(connection),
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
  if (existed) await backupDatabase(connection, options.migrationBackupDirectory, currentVersion, migrations.length)

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
