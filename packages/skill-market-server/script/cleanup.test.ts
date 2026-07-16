import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupPrivateObjects } from "./cleanup"

const directories: string[] = []
const day = 24 * 60 * 60 * 1_000
const now = new Date("2026-07-16T03:10:00.000Z")

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("private object retention", () => {
  test("deletes only rejected or abandoned quarantine objects older than 30 days", async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, "market.db")
    const database = submissionDatabase(databasePath)
    insertSubmission(database, "sub_rejected", "rejected", 1, 31)
    insertSubmission(database, "sub_boundary", "rejected", 1, 30)
    insertSubmission(database, "sub_pending1", "pending_review", 1, 31)
    insertSubmission(database, "sub_published", "published", 1, 31)
    insertSubmission(database, "sub_revised1", "pending_review", 2, 2)
    insertRevision(database, "sub_revised1", 1, 31)
    database.close()
    const store = memoryStore([
      object("private-test/submissions/hash/sub_rejected/1/package.zip", 31),
      object("private-test/submissions/hash/sub_boundary/1/package.zip", 30),
      object("private-test/submissions/hash/sub_pending1/1/package.zip", 31),
      object("private-test/submissions/hash/sub_published/1/package.zip", 31),
      object("private-test/submissions/hash/sub_revised1/1/package.zip", 31),
      object("private-test/submissions/hash/sub_revised1/2/package.zip", 2),
      object("private-test/submissions/hash/sub_missing1/1/package.zip", 31),
      object("private-test/submissions/hash/sub_rejected/1/package.zip.partial-dead", 29),
      object("other-private/submissions/hash/sub_rejected/1/package.zip", 31),
    ])

    const result = await cleanupPrivateObjects({ databasePath, privatePrefix: "private-test", store, now, limit: 20 })

    expect(result.deleted).toEqual([
      "private-test/submissions/hash/sub_missing1/1/package.zip",
      "private-test/submissions/hash/sub_rejected/1/package.zip",
      "private-test/submissions/hash/sub_revised1/1/package.zip",
    ])
    expect(store.deleted).toEqual(result.deleted)
    expect(store.prefixes).toEqual(["private-test/submissions/", "private-test/backups/sqlite/"])
  })

  test("deletes backups only after the 30-day boundary and caps each run", async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, "market.db")
    submissionDatabase(databasePath).close()
    const store = memoryStore([
      object(`private-test/backups/sqlite/20260615T031000Z-v2-${"a".repeat(64)}.db.zst`, 31),
      object(`private-test/backups/sqlite/20260616T031000Z-v2-${"b".repeat(64)}.db.zst`, 30),
      object(`private-test/backups/sqlite/20260617T031000Z-v2-${"c".repeat(64)}.db.zst`, 29),
      object("private-test/backups/not-sqlite/old-31.db.zst", 31),
    ])

    const dryRun = await cleanupPrivateObjects({
      databasePath,
      privatePrefix: "private-test",
      store,
      now,
      limit: 1,
      dryRun: true,
    })
    expect(dryRun.deleted).toEqual([
      `private-test/backups/sqlite/20260615T031000Z-v2-${"a".repeat(64)}.db.zst`,
    ])
    expect(dryRun.truncated).toBe(false)
    expect(store.deleted).toEqual([])
  })
})

function submissionDatabase(path: string) {
  const database = new Database(path, { create: true, readwrite: true })
  database.exec(`
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      current_revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE submission_revisions (
      submission_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (submission_id, revision_number)
    );
  `)
  return database
}

function insertSubmission(database: Database, id: string, status: string, revision: number, age: number) {
  database.query("INSERT INTO submissions VALUES (?, ?, ?, ?)").run(id, status, revision, now.getTime() - age * day)
  insertRevision(database, id, revision, age)
}

function insertRevision(database: Database, id: string, revision: number, age: number) {
  database
    .query("INSERT INTO submission_revisions VALUES (?, ?, ?)")
    .run(id, revision, now.getTime() - age * day)
}

function object(key: string, age: number) {
  return { key, lastModified: new Date(now.getTime() - age * day) }
}

function memoryStore(objects: Array<{ key: string; lastModified: Date }>) {
  const prefixes: string[] = []
  const deleted: string[] = []
  return {
    prefixes,
    deleted,
    async list(prefix: string) {
      prefixes.push(prefix)
      return objects.filter((entry) => entry.key.startsWith(prefix))
    },
    async delete(key: string) {
      deleted.push(key)
    },
  }
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-cleanup-"))
  directories.push(directory)
  return directory
}
