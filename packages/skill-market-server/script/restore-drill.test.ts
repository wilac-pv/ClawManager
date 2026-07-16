import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { restoreDrill } from "./restore-drill"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("database restore drill", () => {
  test("restores the latest valid backup and removes all temporary files", async () => {
    const directory = await temporaryDirectory()
    const temporary = join(directory, "restore")
    const older = await backupObject(directory, "20260715T041000Z", 2)
    const latest = await backupObject(directory, "20260716T041000Z", 2)
    const store = memoryStore([older, latest])

    const result = await restoreDrill({
      privatePrefix: "private-test",
      temporaryDirectory: temporary,
      expectedUserVersion: 2,
      store,
    })

    expect(result.key).toBe(latest.key)
    expect(result.userVersion).toBe(2)
    expect(await readdir(temporary)).toEqual([])
  })

  test.each([
    ["corrupt zstd", false, "restore decompression failed"],
    ["corrupt SQLite", true, "restore database check failed"],
  ])("rejects %s without leaving temporary files", async (_name, compressed, message) => {
    const directory = await temporaryDirectory()
    const temporary = join(directory, "restore")
    const body = compressed
      ? await compress(new TextEncoder().encode("not-sqlite"))
      : new TextEncoder().encode("not-zstd")
    const store = memoryStore([objectFromBody(body, "20260716T041000Z", 2)])

    await expect(
      restoreDrill({ privatePrefix: "private-test", temporaryDirectory: temporary, expectedUserVersion: 2, store }),
    ).rejects.toThrow(message)
    expect(await readdir(temporary)).toEqual([])
  })

  test("rejects schema and foreign-key violations without touching a live database", async () => {
    const directory = await temporaryDirectory()
    const temporary = join(directory, "restore")
    const livePath = join(directory, "live.db")
    const live = new Database(livePath, { create: true })
    live.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('preserved');")
    live.close()
    const wrongVersion = await backupObject(directory, "20260716T041000Z", 9)
    const foreignKey = await backupObject(directory, "20260717T041000Z", 2, true)

    await expect(
      restoreDrill({
        privatePrefix: "private-test",
        temporaryDirectory: temporary,
        expectedUserVersion: 2,
        store: memoryStore([wrongVersion]),
      }),
    ).rejects.toThrow("restore schema version mismatch")
    await expect(
      restoreDrill({
        privatePrefix: "private-test",
        temporaryDirectory: temporary,
        expectedUserVersion: 2,
        store: memoryStore([foreignKey]),
      }),
    ).rejects.toThrow("restore foreign key check failed")

    const reopened = new Database(livePath, { readonly: true })
    expect(reopened.query<{ value: string }, []>("SELECT value FROM marker").get()?.value).toBe("preserved")
    reopened.close()
    expect(await readdir(temporary)).toEqual([])
  })
})

async function backupObject(directory: string, timestamp: string, userVersion: number, invalidForeignKey = false) {
  const path = join(directory, `${timestamp}-${userVersion}-${invalidForeignKey}.db`)
  const database = new Database(path, { create: true, readwrite: true })
  database.exec(`
    PRAGMA user_version = ${userVersion};
    PRAGMA foreign_keys = OFF;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    INSERT INTO parent VALUES (1);
    INSERT INTO child VALUES (1, ${invalidForeignKey ? 2 : 1});
  `)
  database.close()
  return objectFromBody(await compress(new Uint8Array(await Bun.file(path).arrayBuffer())), timestamp, userVersion)
}

function objectFromBody(body: Uint8Array, timestamp: string, userVersion: number) {
  const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
  return {
    key: `private-test/backups/sqlite/${timestamp}-v${userVersion}-${sha256}.db.zst`,
    body,
    metadata: { sha256, "user-version": String(userVersion) },
    lastModified: new Date(timestamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")),
  }
}

function memoryStore(objects: ReadonlyArray<ReturnType<typeof objectFromBody>>) {
  return {
    async list(prefix: string) {
      return objects.filter((object) => object.key.startsWith(prefix))
    },
    async get(key: string) {
      return objects.find((object) => object.key === key)!.body
    },
    async head(key: string) {
      const object = objects.find((candidate) => candidate.key === key)!
      return { size: object.body.byteLength, metadata: object.metadata }
    },
  }
}

async function compress(body: Uint8Array) {
  const process = Bun.spawn(["zstd", "-T1", "-q", "-c"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  process.stdin.write(body)
  process.stdin.end()
  const output = new Uint8Array(await new Response(process.stdout).arrayBuffer())
  expect(await process.exited).toBe(0)
  return output
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-restore-"))
  directories.push(directory)
  return directory
}
