import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import type { PrivateObjectStore } from "../src/oss"
import type { Principal } from "../src/security"
import { createSubmissions } from "../src/submissions"
import { createWorker } from "../src/worker"
import { makeStoredZip } from "./zip"

const directories: string[] = []
const clock = { value: Date.parse("2026-07-15T00:00:00.000Z") }

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("durable skill market worker", () => {
  test("resumes validation after restart and lets different workers claim different submissions", async () => {
    const fixture = await workerFixture(["alpha-skill", "beta-skill"])
    fixture.database.close()
    const database = await openDatabase({
      databasePath: fixture.databasePath,
      migrationBackupDirectory: fixture.backupPath,
    })
    const metrics: unknown[] = []
    const worker = createWorker({
      database,
      submissions: createSubmissions({ database, now: () => clock.value }),
      store: fixture.store,
      now: () => clock.value,
      emit: (metric) => metrics.push(metric),
    })

    const results = await Promise.all([worker.runOne("worker-a"), worker.runOne("worker-b")])

    expect(results.map((result) => result?.kind)).toEqual(["validation", "validation"])
    expect(
      database.connection
        .query<{ status: string }, []>("SELECT status FROM submissions ORDER BY id")
        .all()
        .map((row) => row.status),
    ).toEqual(["pending_review", "pending_review"])
    expect(
      database.connection
        .query<
          { validation_completed_at: number | null; validation_lease_owner: string | null },
          []
        >("SELECT validation_completed_at, validation_lease_owner FROM submission_revisions ORDER BY submission_id")
        .all(),
    ).toEqual([
      { validation_completed_at: clock.value, validation_lease_owner: null },
      { validation_completed_at: clock.value, validation_lease_owner: null },
    ])
    expect(JSON.stringify(metrics)).not.toContain("E123456")
    expect(JSON.stringify(metrics)).not.toContain("private/")
    expect(JSON.stringify(metrics)).not.toContain(fixture.hashes[0])
    database.close()
  })

  test("reclaims expired work, coalesces wakeups, and records invalid archives without sensitive evidence", async () => {
    const fixture = await workerFixture(["recover-skill", "invalid-skill"], { invalidIndex: 1 })
    fixture.database.connection.run(
      `UPDATE submission_revisions
       SET validation_lease_owner = 'crashed-worker', validation_lease_expires_at = ?
       WHERE submission_id = 'sub_00000000'`,
      [clock.value - 1],
    )
    const metrics: unknown[] = []
    const worker = createWorker({
      database: fixture.database,
      submissions: createSubmissions({ database: fixture.database, now: () => clock.value }),
      store: fixture.store,
      now: () => clock.value,
      emit: (metric) => metrics.push(metric),
    })

    await Promise.all([worker.wake("server"), worker.wake("server")])

    expect(
      fixture.database.connection
        .query<{ id: string; status: string }, []>("SELECT id, status FROM submissions ORDER BY id")
        .all(),
    ).toEqual([
      { id: "sub_00000000", status: "pending_review" },
      { id: "sub_00000001", status: "validation_failed" },
    ])
    const failure = fixture.database.connection
      .query<
        { validation_errors_json: string; validation_lease_owner: string | null },
        []
      >("SELECT validation_errors_json, validation_lease_owner FROM submission_revisions WHERE submission_id = 'sub_00000001'")
      .get()!
    expect(failure.validation_lease_owner).toBeNull()
    expect(failure.validation_errors_json).toContain("archive-invalid")
    expect(failure.validation_errors_json).not.toContain("sk-super-secret-value")
    expect(metrics.filter((metric) => JSON.stringify(metric).includes("skill_market_validation_result"))).toHaveLength(
      2,
    )
    fixture.database.close()
  })

  test("releases transient object-store failures for retry and cleans expired ephemeral records", async () => {
    const fixture = await workerFixture(["retry-skill"])
    fixture.failGet.value = true
    fixture.database.connection.run(
      "INSERT INTO login_attempts (attempt_hash, return_to, created_at, expires_at) VALUES ('expired-attempt', '/skills', ?, ?)",
      [clock.value - 10_000, clock.value - 1],
    )
    fixture.database.connection.run(
      `INSERT INTO sessions
        (session_hash, employee_id, csrf_hash, created_at, last_activity_at, absolute_expires_at)
       VALUES ('expired-session', 'E123456', 'csrf', ?, ?, ?)`,
      [clock.value - 10_000, clock.value - 10_000, clock.value - 1],
    )
    fixture.database.connection.run(
      `INSERT INTO idempotency_keys
        (employee_id, route, idempotency_key, request_hash, response_json, created_at, expires_at)
       VALUES ('E123456', 'test', 'expired-key', 'hash', '{}', ?, ?)`,
      [clock.value - 10_000, clock.value - 1],
    )
    const metrics: unknown[] = []
    const worker = createWorker({
      database: fixture.database,
      submissions: createSubmissions({ database: fixture.database, now: () => clock.value }),
      store: fixture.store,
      now: () => clock.value,
      emit: (metric) => metrics.push(metric),
    })

    expect(await worker.runOne("worker-a")).toMatchObject({ kind: "validation", result: "retry" })
    expect(
      fixture.database.connection.query<{ status: string }, []>("SELECT status FROM submissions").get()?.status,
    ).toBe("validating")
    expect(
      fixture.database.connection
        .query<{ validation_lease_owner: string | null }, []>("SELECT validation_lease_owner FROM submission_revisions")
        .get()?.validation_lease_owner,
    ).toBeNull()

    fixture.failGet.value = false
    expect(await worker.runOne("worker-b")).toMatchObject({ kind: "validation", result: "success" })
    expect(worker.cleanup()).toEqual({ loginAttempts: 1, sessions: 1, idempotencyKeys: 1 })
    expect(JSON.stringify(metrics)).not.toContain("object store unavailable")
    fixture.database.close()
  })

  test("retries when validated artifacts cannot be persisted", async () => {
    const fixture = await workerFixture(["artifact-retry-skill"])
    fixture.failPutPrivate.value = true
    const worker = createWorker({
      database: fixture.database,
      submissions: createSubmissions({ database: fixture.database, now: () => clock.value }),
      store: fixture.store,
      now: () => clock.value,
      emit: () => undefined,
    })

    expect(await worker.runOne("worker-a")).toMatchObject({ kind: "validation", result: "retry" })
    expect(
      fixture.database.connection.query<{ status: string }, []>("SELECT status FROM submissions").get()?.status,
    ).toBe("validating")

    fixture.failPutPrivate.value = false
    expect(await worker.runOne("worker-b")).toMatchObject({ kind: "validation", result: "success" })
    fixture.database.close()
  })

  test("drains publication work after validation is idle", async () => {
    const fixture = await workerFixture([])
    const metrics: unknown[] = []
    const calls: string[] = []
    const worker = createWorker({
      database: fixture.database,
      submissions: createSubmissions({ database: fixture.database, now: () => clock.value }),
      store: fixture.store,
      publisher: {
        async runOne(workerID) {
          calls.push(workerID)
          if (calls.length === 1)
            return { jobID: "job_test", kind: "catalog_rebuild" as const, revision: "revision-test" }
          return undefined
        },
      },
      now: () => clock.value,
      emit: (metric) => metrics.push(metric),
    })

    await worker.drain("worker-a")

    expect(calls).toEqual(["worker-a", "worker-a"])
    expect(metrics).toEqual([expect.objectContaining({ skill_market_publish_result: { success: 1 } })])
    fixture.database.close()
  })
})

async function workerFixture(skillIDs: ReadonlyArray<string>, options: { invalidIndex?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-worker-"))
  directories.push(directory)
  const databasePath = join(directory, "market.db")
  const backupPath = join(directory, "backups")
  const database = await openDatabase({ databasePath, migrationBackupDirectory: backupPath })
  database.connection.run(
    "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES ('E123456', 'CONTRIBUTOR', ?, ?)",
    [clock.value, clock.value],
  )
  const objects = new Map<string, Uint8Array>()
  const failGet = { value: false }
  const failPutPrivate = { value: false }
  const store = memoryStore(objects, failGet, failPutPrivate)
  const submissions = createSubmissions({ database, now: () => clock.value })
  const principal = contributor()
  const hashes = await Promise.all(
    skillIDs.map(async (skillID, index) => {
      const body =
        index === options.invalidIndex
          ? new TextEncoder().encode("not-a-zip sk-super-secret-value")
          : makeStoredZip({
              "SKILL.md": `---\nname: ${skillID}\ndescription: Validate safely\n---\n# ${skillID}\n`,
            })
      const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex")
      const key = `private/sub_${String(index).padStart(8, "0")}/package.zip`
      objects.set(key, body)
      await submissions.create(principal, {
        idempotencyKey: `worker-fixture-${index}`,
        submissionID: `sub_${String(index).padStart(8, "0")}`,
        verifiedSkillID: skillID,
        metadata: {
          version: `1.0.${index}`,
          displayName: skillID,
          description: "Validate safely",
          category: "Development",
          tags: ["validation"],
          license: "MIT",
          requiresApiKey: false,
          changeNotes: "Initial validation",
        },
        package: { key, sha256: hash, size: body.byteLength },
      })
      return hash
    }),
  )
  return { database, databasePath, backupPath, objects, store, failGet, failPutPrivate, hashes }
}

function contributor(): Principal {
  return {
    csrfHash: "",
    session: {
      user: { employeeID: "E123456", displayName: "CONTRIBUTOR" },
      roles: [],
      csrfToken: "_".repeat(43),
      createdAt: new Date(clock.value).toISOString(),
      absoluteExpiresAt: new Date(clock.value + 60_000).toISOString(),
      idleExpiresAt: new Date(clock.value + 60_000).toISOString(),
    },
  }
}

function memoryStore(
  objects: Map<string, Uint8Array>,
  failGet: { value: boolean },
  failPutPrivate: { value: boolean },
): PrivateObjectStore {
  return {
    async put(key, body) {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
    },
    async get(key) {
      if (failGet.value) throw new Error("object store unavailable")
      const body = objects.get(key)
      if (!body) throw new Error("object is missing")
      return body
    },
    async head(key) {
      const body = objects.get(key)
      if (!body) throw new Error("object is missing")
      return { size: body.byteLength }
    },
    async putPrivate(key, body) {
      if (failPutPrivate.value) throw new Error("object store unavailable")
      objects.set(key, new Uint8Array(await new Blob(await Array.fromAsync(body)).arrayBuffer()))
    },
    async copy(source, target) {
      const body = objects.get(source)
      if (!body) throw new Error("object is missing")
      objects.set(target, body.slice())
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}
