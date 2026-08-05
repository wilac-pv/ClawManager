import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateDatabase } from "./migrate"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("database migration command", () => {
  test("migrates and verifies the control database without starting HTTP", async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, "market.db")

    const result = await migrateDatabase({
      databasePath,
      migrationBackupDirectory: join(directory, "backups"),
    })

    expect(result).toEqual({ userVersion: 13, integrity: "ok", foreignKeyViolations: 0 })
    const database = new Database(databasePath, { create: false, readwrite: true })
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM submissions").get()?.count).toBe(0)
    database.close()
  })

  test("exposes a package script for the non-listening migration entrypoint", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
    expect(manifest.scripts.migrate).toBe("bun script/migrate.ts")
  })

  test("accepts a production database that already applied historical migrations", async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, "market.db")
    const migrations = join(directory, "v4-migrations")
    await mkdir(migrations)
    await Promise.all(
      ["001_control_plane.sql", "002_submission_icons.sql", "003_skillhub_import.sql", "004_skillhub_import_invariants.sql"].map(
        (file) => Bun.write(join(migrations, file), Bun.file(new URL(`../migrations/${file}`, import.meta.url))),
      ),
    )
    await expect(
      migrateDatabase({
        databasePath,
        migrationBackupDirectory: join(directory, "backups"),
        migrationDirectory: migrations,
      }),
    ).resolves.toEqual({ userVersion: 4, integrity: "ok", foreignKeyViolations: 0 })

    await expect(
      migrateDatabase({
        databasePath,
        migrationBackupDirectory: join(directory, "backups"),
      }),
    ).resolves.toEqual({ userVersion: 13, integrity: "ok", foreignKeyViolations: 0 })
  })

  test("runs with only migration-specific environment", async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, "market.db")
    const subprocess = Bun.spawn([process.execPath, "script/migrate.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        PATH: process.env.PATH,
        SKILL_MARKET_DATABASE_PATH: databasePath,
        SKILL_MARKET_MIGRATION_BACKUP_DIRECTORY: join(directory, "backups"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await subprocess.exited).toBe(0)
    expect(await new Response(subprocess.stdout).json()).toEqual({
      userVersion: 13,
      integrity: "ok",
      foreignKeyViolations: 0,
    })
    expect(await new Response(subprocess.stderr).text()).toBe("")
  })
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-migrate-"))
  directories.push(directory)
  return directory
}
