import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { loadCurrentSnapshot, publishSnapshot, type PrivateObjectStore } from "../src/oss"
import { createPublisher } from "../src/publisher"
import { validateSubmissionArchive } from "../src/submission-archive"
import { sampleSnapshot } from "./fixture"
import { makeStoredZip } from "./zip"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("community publisher", () => {
  test("leases one pending job across concurrent workers and publishes exactly once", async () => {
    const fixture = await publisherFixture()
    const publisher = createPublisher(publisherOptions(fixture))
    const results = await Promise.all([publisher.runOne("worker-a"), publisher.runOne("worker-b")])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(
      fixture.database.connection
        .query<{ status: string }, []>("SELECT status FROM submissions WHERE id = 'sub_publish_12345678'")
        .get()?.status,
    ).toBe("published")
    expect(
      fixture.database.connection.query<{ status: string }, []>("SELECT status FROM publish_jobs").get()?.status,
    ).toBe("completed")
    expect(fixture.copies.filter((copy) => copy.includes("packages/community"))).toHaveLength(1)
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    expect(snapshot.details.get("community:community-publish")).toMatchObject({
      version: "1.0.0",
      submittedBy: { displayName: "CONTRIBUTOR" },
    })
    expect(
      fixture.database.connection
        .query<{ action: string }, []>(
          "SELECT action FROM audit_events WHERE action IN ('publish-started', 'publish-succeeded') ORDER BY rowid",
        )
        .all()
        .map((event) => event.action),
    ).toEqual(["publish-started", "publish-succeeded"])

    fixture.database.close()
  })

  test("finalizes an expired pointer-ahead job without republishing immutable objects", async () => {
    const fixture = await publisherFixture()
    const publisher = createPublisher(publisherOptions(fixture))
    await publisher.runOne("worker-a")
    const copies = fixture.copies.length
    fixture.clock.value += 60_000
    fixture.database.transaction((connection) => {
      connection.run(
        `UPDATE publish_jobs
         SET status = 'running', lease_owner = 'crashed-worker', lease_expires_at = ?, updated_at = ?`,
        [fixture.clock.value - 1, fixture.clock.value - 1],
      )
      connection.run(
        "UPDATE submissions SET status = 'publishing', version = version + 1 WHERE id = 'sub_publish_12345678'",
      )
      connection.run(
        `UPDATE community_skills
         SET current_version = NULL, current_submission_id = NULL, public_status = NULL, version = version + 1
         WHERE skill_id = 'community-publish'`,
      )
    })

    expect(await publisher.recover()).toBe(1)
    expect(fixture.copies).toHaveLength(copies)
    expect(
      fixture.database.connection.query<{ status: string }, []>("SELECT status FROM publish_jobs").get()?.status,
    ).toBe("completed")
    expect(
      fixture.database.connection
        .query<{ current_version: string }, []>("SELECT current_version FROM community_skills")
        .get()?.current_version,
    ).toBe("1.0.0")

    fixture.database.close()
  })

  test("retries immutable work after the pointer write fails and the lease expires", async () => {
    const fixture = await publisherFixture()
    const publisher = createPublisher(publisherOptions(fixture))
    fixture.failures.put = /current\.json$/

    const failure = await rejected(publisher.runOne("worker-a"))
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("configured put failure")
    expect(
      fixture.database.connection
        .query<
          { target_revision: string | null; status: string },
          []
        >("SELECT target_revision, status FROM publish_jobs")
        .get(),
    ).toMatchObject({ status: "running" })
    expect((await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })).revision).toBe("initial")

    fixture.failures.put = undefined
    fixture.clock.value += 60_000
    expect(await publisher.recover()).toBe(1)
    await publisher.runOne("worker-b")
    expect(
      fixture.database.connection
        .query<{ status: string; attempts: number }, []>("SELECT status, attempts FROM publish_jobs")
        .get(),
    ).toEqual({ status: "completed", attempts: 2 })
    expect(fixture.copies.filter((copy) => copy.includes("packages/community"))).toHaveLength(2)

    fixture.database.close()
  })

  test("recovers a pointer moved before the final database transaction", async () => {
    const fixture = await publisherFixture()
    const publisher = createPublisher(publisherOptions(fixture))
    fixture.database.connection.run(
      `CREATE TRIGGER fail_publish_finalize
       BEFORE INSERT ON audit_events
       WHEN NEW.action = 'publish-succeeded'
       BEGIN
         SELECT RAISE(ABORT, 'configured finalization failure');
       END`,
    )

    const failure = await rejected(publisher.runOne("worker-a"))
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("configured finalization failure")
    const pointer = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    expect(pointer.details.has("community:community-publish")).toBe(true)
    expect(
      fixture.database.connection.query<{ status: string }, []>("SELECT status FROM submissions").get()?.status,
    ).toBe("publishing")
    const copies = fixture.copies.length

    fixture.database.connection.run("DROP TRIGGER fail_publish_finalize")
    fixture.clock.value += 60_000
    expect(await publisher.recover()).toBe(1)
    expect(fixture.copies).toHaveLength(copies)
    expect(
      fixture.database.connection.query<{ status: string }, []>("SELECT status FROM submissions").get()?.status,
    ).toBe("published")

    fixture.database.close()
  })

  test("rebuilds the catalog after a published community skill is delisted", async () => {
    const fixture = await publisherFixture()
    const publisher = createPublisher(publisherOptions(fixture))
    await publisher.runOne("worker-a")
    fixture.database.transaction((connection) => {
      connection.run(
        `UPDATE community_skills
         SET public_status = 'delisted', delist_reason = 'Policy review', version = version + 1
         WHERE skill_id = 'community-publish'`,
      )
      connection.run(
        `INSERT INTO publish_jobs (id, kind, status, attempts, created_at, updated_at)
         VALUES ('job_rebuild_12345678', 'catalog_rebuild', 'pending', 0, ?, ?)`,
        [fixture.clock.value, fixture.clock.value],
      )
    })

    await publisher.runOne("worker-b")
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    expect(snapshot.details.has("community:community-publish")).toBe(false)
    expect(snapshot.sourceStatus.community).toBe("fresh")
    expect(fixture.copies.filter((copy) => copy.includes("packages/community"))).toHaveLength(1)

    fixture.database.close()
  })
})

async function publisherFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-publisher-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const archive = makeStoredZip({
    "SKILL.md": "---\nname: community-publish\ndescription: Publish safely\n---\n# Community Publish\n",
  })
  const metadata = {
    version: "1.0.0",
    displayName: "Community Publish",
    description: "Publish safely",
    category: "Development",
    tags: ["publish"],
    license: "MIT",
    requiresApiKey: false,
    changeNotes: "Initial release",
  } as const
  const validation = validateSubmissionArchive(archive, metadata, () => Date.parse("2026-07-15T00:30:00.000Z"))
  const objects = new Map<string, Uint8Array>([["private/sub_publish_12345678/package.zip", archive]])
  const metadataByKey = new Map<string, Readonly<Record<string, string>>>()
  const copies: string[] = []
  const failures: { put?: RegExp } = {}
  const store = memoryStore(objects, metadataByKey, copies, failures)
  await publishSnapshot(store, { prefix: "skill-market" }, sampleSnapshot("initial"))
  const clock = { value: Date.parse("2026-07-15T01:00:00.000Z") }
  database.transaction((connection) => {
    connection.run(
      "INSERT INTO users (employee_id, display_name, email, created_at, last_login_at) VALUES ('E123456', 'CONTRIBUTOR', 'contributor@example.com', ?, ?)",
      [clock.value, clock.value],
    )
    connection.run(
      `INSERT INTO submissions
        (id, skill_id, owner_employee_id, target_version, status, current_revision, version, created_at, updated_at)
       VALUES ('sub_publish_12345678', 'community-publish', 'E123456', '1.0.0', 'publishing', 1, 3, ?, ?)`,
      [clock.value, clock.value],
    )
    connection.run(
      `INSERT INTO submission_revisions
        (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json,
         manifest_json, scan_json, validation_errors_json, validation_completed_at, created_at)
       VALUES ('sub_publish_12345678', 1, 'private/sub_publish_12345678/package.zip', ?, ?, ?, ?, ?, '[]', ?, ?)`,
      [
        validation.manifest.packageSha256,
        archive.byteLength,
        JSON.stringify(metadata),
        JSON.stringify(validation.manifest),
        JSON.stringify(validation.scan),
        clock.value,
        clock.value,
      ],
    )
    connection.run(
      `INSERT INTO reviews
        (id, submission_id, revision_number, reviewer_employee_id, decision, created_at)
       VALUES ('review_publish_12345678', 'sub_publish_12345678', 1, 'E123456', 'approve', ?)`,
      [clock.value],
    )
    connection.run(
      `INSERT INTO community_skills
        (skill_id, owner_employee_id, version, created_at, updated_at)
       VALUES ('community-publish', 'E123456', 1, ?, ?)`,
      [clock.value, clock.value],
    )
    connection.run(
      `INSERT INTO publish_jobs
        (id, submission_id, kind, status, attempts, created_at, updated_at)
       VALUES ('job_publish_12345678', 'sub_publish_12345678', 'publish', 'pending', 0, ?, ?)`,
      [clock.value, clock.value],
    )
  })
  return { database, store, objects, metadataByKey, copies, failures, clock, validation }
}

function publisherOptions(fixture: Awaited<ReturnType<typeof publisherFixture>>) {
  return {
    database: fixture.database,
    store: fixture.store,
    ossPrefix: "skill-market",
    publicBaseUrl: "https://oss.example.com/skill-market/",
    webBaseUrl: "https://market.example.com/",
    leaseMilliseconds: 30_000,
    now: () => fixture.clock.value,
  }
}

function memoryStore(
  objects: Map<string, Uint8Array>,
  metadataByKey: Map<string, Readonly<Record<string, string>>>,
  copies: string[],
  failures: { put?: RegExp },
): PrivateObjectStore {
  return {
    async put(key, body) {
      if (failures.put?.test(key)) throw new Error(`configured put failure for ${key}`)
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
    },
    async get(key) {
      const body = objects.get(key)
      if (!body) throw new Error(`missing ${key}`)
      return body
    },
    async head(key) {
      const body = objects.get(key)
      if (!body) throw new Error(`missing ${key}`)
      return { size: body.byteLength, metadata: metadataByKey.get(key) }
    },
    async putPrivate(key, body) {
      const chunks = await Array.fromAsync(body)
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      const output = new Uint8Array(size)
      chunks.reduce((offset, chunk) => {
        output.set(chunk, offset)
        return offset + chunk.byteLength
      }, 0)
      objects.set(key, output)
    },
    async copy(source, target, _contentType, metadata) {
      const body = objects.get(source)
      if (!body) throw new Error(`missing ${source}`)
      objects.set(target, body.slice())
      if (metadata) metadataByKey.set(target, metadata)
      copies.push(`${source}->${target}`)
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

function rejected<T>(promise: Promise<T>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}
