import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backupDatabase } from "./backup"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("database backup", () => {
  test("exposes maintenance commands through package scripts", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json()
    expect(manifest.scripts).toMatchObject({
      backup: "bun script/backup.ts",
      cleanup: "bun script/cleanup.ts",
      "restore-drill": "bun script/restore-drill.ts",
    })
  })

  test("backs up a real WAL database without partial committed transactions", async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, "market.db")
    const writer = createWalDatabase(databasePath)
    Array.from({ length: 20 }, (_, index) => index + 1).forEach((id) => insertPair(writer, id))
    const store = memoryStore()

    const writes = Array.from({ length: 40 }, async (_, index) => {
      await Bun.sleep(index % 4)
      insertPair(writer, index + 21)
    })
    const backup = await backupDatabase({
      databasePath,
      backupDirectory: join(directory, "backups"),
      privatePrefix: "private-test",
      store: store.client,
      now: new Date("2026-07-16T02:10:00.000Z"),
    })
    await Promise.all(writes)
    writer.close()

    expect(backup.key).toMatch(/^private-test\/backups\/sqlite\/20260716T021000Z-v7-[a-f0-9]{64}\.db\.zst$/)
    expect(store.metadata.get(backup.key)).toEqual({ sha256: backup.sha256, "user-version": "7" })
    const restored = await decompress(store.objects.get(backup.key)!, directory)
    const snapshot = new Database(restored, { readonly: true })
    const parents = snapshot.query<{ count: number }, []>("SELECT count(*) AS count FROM parent").get()!.count
    const children = snapshot.query<{ count: number }, []>("SELECT count(*) AS count FROM child").get()!.count
    expect(parents).toBeGreaterThanOrEqual(20)
    expect(children).toBe(parents)
    expect(snapshot.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
    snapshot.close()
  })

  test("keeps the live database untouched and redacts upload failures", async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, "market.db")
    const database = createWalDatabase(databasePath)
    insertPair(database, 1)
    database.close()

    const error = await backupDatabase({
      databasePath,
      backupDirectory: join(directory, "backups"),
      privatePrefix: "private-test",
      store: {
        ...memoryStore().client,
        putPrivate: async () => {
          throw new Error("upload rejected secret-marker")
        },
      },
      now: new Date("2026-07-16T02:10:00.000Z"),
    }).then(() => "", String)

    expect(error).toContain("backup upload failed")
    expect(error).not.toContain("secret-marker")
    const live = new Database(databasePath, { readonly: true })
    expect(live.query<{ count: number }, []>("SELECT count(*) AS count FROM parent").get()?.count).toBe(1)
    live.close()
    expect((await readdir(join(directory, "backups"))).filter((file) => file.endsWith(".tmp"))).toEqual([])
  })
})

function createWalDatabase(path: string) {
  const database = new Database(path, { create: true, readwrite: true })
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 7;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER PRIMARY KEY REFERENCES parent(id));
  `)
  return database
}

function insertPair(database: Database, id: number) {
  database.transaction(() => {
    database.query("INSERT INTO parent (id) VALUES (?)").run(id)
    database.query("INSERT INTO child (id) VALUES (?)").run(id)
  })()
}

function memoryStore() {
  const objects = new Map<string, Uint8Array>()
  const metadata = new Map<string, Readonly<Record<string, string>>>()
  return {
    objects,
    metadata,
    client: {
      async putPrivate(
        key: string,
        body: AsyncIterable<Uint8Array>,
        _contentType: string,
        objectMetadata?: Readonly<Record<string, string>>,
      ) {
        const chunks = await Array.fromAsync(body)
        objects.set(key, Buffer.concat(chunks))
        metadata.set(key, objectMetadata ?? {})
      },
    },
  }
}

async function decompress(body: Uint8Array, directory: string) {
  const compressed = join(directory, "restore.db.zst")
  const restored = join(directory, "restore.db")
  await Bun.write(compressed, body)
  const process = Bun.spawn(["zstd", "-T1", "-q", "-d", compressed, "-o", restored], { stderr: "pipe" })
  expect(await process.exited).toBe(0)
  return restored
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-backup-"))
  directories.push(directory)
  return directory
}
