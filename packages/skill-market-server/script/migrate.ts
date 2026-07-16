import { openDatabase } from "../src/database"

export async function migrateDatabase(options: {
  readonly databasePath: string
  readonly migrationBackupDirectory: string
  readonly migrationDirectory?: string
}) {
  const database = await openDatabase(options)
  try {
    const integrity = database.connection.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
      ?.integrity_check
    if (integrity !== "ok") throw new Error("database migration integrity check failed")
    const foreignKeyViolations = database.connection.query("PRAGMA foreign_key_check").all().length
    if (foreignKeyViolations > 0) throw new Error("database migration foreign key check failed")
    const userVersion = database.connection.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
    return { userVersion, integrity, foreignKeyViolations }
  } finally {
    database.close()
  }
}

if (import.meta.main) {
  console.log(
    JSON.stringify(
      await migrateDatabase({
        databasePath: process.env.SKILL_MARKET_DATABASE_PATH ?? "/var/lib/ruying-skill-market/market.db",
        migrationBackupDirectory:
          process.env.SKILL_MARKET_MIGRATION_BACKUP_DIRECTORY ?? "/var/backups/ruying-skill-market/migrations",
      }),
    ),
  )
}
