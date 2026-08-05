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
    const writer = createWalDatabase(databasePath, 11)
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

    expect(backup.key).toMatch(/^private-test\/backups\/sqlite\/20260716T021000Z-v11-[a-f0-9]{64}\.db\.zst$/)
    expect(store.metadata.get(backup.key)).toEqual({ sha256: backup.sha256, "user-version": "11" })
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
    const database = createWalDatabase(databasePath, 11)
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

  test("rejects a snapshot missing migration 011 scoped-sharing tables and schema safeguards", async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, "market.db")
    const database = createWalDatabase(databasePath, 11)
    database.exec("DROP TABLE market_groups")
    database.close()

    await expect(
      backupDatabase({
        databasePath,
        backupDirectory: join(directory, "backups"),
        privatePrefix: "private-test",
        store: memoryStore().client,
      }),
    ).rejects.toThrow("scoped-sharing backup schema is incomplete")
  })

  test("accepts a coherent pre-migration v10 backup for rollback", async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, "market.db")
    const database = createWalDatabase(databasePath, 10, false)
    database.close()

    await expect(
      backupDatabase({
        databasePath,
        backupDirectory: join(directory, "backups"),
        privatePrefix: "private-test",
        store: memoryStore().client,
      }),
    ).resolves.toMatchObject({ userVersion: 10 })
  })
})

function createWalDatabase(path: string, userVersion: number, scoped = true) {
  const database = new Database(path, { create: true, readwrite: true })
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = ${userVersion};
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER PRIMARY KEY REFERENCES parent(id));
    ${scoped ? `
    CREATE TABLE submissions (id TEXT PRIMARY KEY);
    CREATE TABLE reviews (
      approved_package_key TEXT,
      approved_package_sha256 TEXT,
      approved_package_size INTEGER,
      approved_metadata_json TEXT
    );
    CREATE TABLE market_groups (id TEXT PRIMARY KEY);
    CREATE TABLE market_group_members (group_id TEXT, employee_id TEXT, PRIMARY KEY (group_id, employee_id));
    CREATE TABLE submission_group_targets (submission_id TEXT, group_id TEXT, PRIMARY KEY (submission_id, group_id));
    CREATE TABLE restricted_publications (id TEXT PRIMARY KEY);
    CREATE TABLE restricted_publication_groups (publication_id TEXT, group_id TEXT, PRIMARY KEY (publication_id, group_id));
    CREATE TABLE private_install_grants (token_hash TEXT PRIMARY KEY);
    CREATE INDEX market_group_members_employee ON market_group_members(employee_id, group_id);
    CREATE INDEX submission_group_targets_group ON submission_group_targets(group_id, submission_id);
    CREATE INDEX restricted_publications_owner ON restricted_publications(id);
    CREATE INDEX restricted_publications_department ON restricted_publications(id);
    CREATE INDEX restricted_publications_live_owner_skill_version ON restricted_publications(id);
    CREATE INDEX restricted_publication_groups_group ON restricted_publication_groups(group_id, publication_id);
    CREATE INDEX private_install_grants_expiry ON private_install_grants(token_hash);
    CREATE INDEX submissions_active_restricted_skill_version ON submissions(id);
    CREATE INDEX submissions_active_audience_change_source ON submissions(id);
    CREATE TRIGGER submissions_audience_no_update BEFORE UPDATE ON submissions BEGIN SELECT 1; END;
    CREATE TRIGGER submission_group_targets_valid_insert BEFORE INSERT ON submission_group_targets BEGIN SELECT 1; END;
    CREATE TRIGGER submission_group_targets_no_update BEFORE UPDATE ON submission_group_targets BEGIN SELECT 1; END;
    CREATE TRIGGER submission_group_targets_no_delete BEFORE DELETE ON submission_group_targets BEGIN SELECT 1; END;
    CREATE TRIGGER submissions_audience_valid_transition BEFORE UPDATE ON submissions BEGIN SELECT 1; END;
    ` : ""}
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
