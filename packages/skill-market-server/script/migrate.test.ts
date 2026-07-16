import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
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

    expect(result).toEqual({ userVersion: 2, integrity: "ok", foreignKeyViolations: 0 })
    const database = new Database(databasePath, { create: false, readwrite: true })
    expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM submissions").get()?.count).toBe(0)
    database.close()
  })

  test("exposes a package script for the non-listening migration entrypoint", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
    expect(manifest.scripts.migrate).toBe("bun script/migrate.ts")
  })
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-migrate-"))
  directories.push(directory)
  return directory
}
