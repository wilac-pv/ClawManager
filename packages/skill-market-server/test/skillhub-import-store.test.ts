import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { createSkillHubImportStore } from "../src/skillhub-import-store"
import type { SkillHubListRecord, SkillHubRecord } from "../src/skillhub"
import { sampleDetail } from "./fixture"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("SkillHub import store", () => {
  test("adopts an active generation and reclaims expired item leases", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database, now: () => clock.value })
    const generation = store.beginGeneration(78_253)

    expect(store.beginGeneration(10)).toEqual(generation)
    store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0")])
    expect(store.activeGeneration()).toEqual({
      id: generation.id,
      state: "running",
      upstreamTotal: 10,
      discoveryPage: 1,
      sweep: 0,
      newInSweep: 1,
    })
    expect(store.command({ command: "pause" }).state).toBe("paused")
    expect(store.claim("worker-a", 6, 60_000)).toEqual([])
    expect(store.command({ command: "resume" }).state).toBe("running")
    expect(store.claim("worker-a", 6, 60_000).map((item) => item.slug)).toEqual(["alpha"])
    expect(store.claim("worker-b", 6, 60_000)).toEqual([])

    clock.value += 60_001
    expect(store.claim("worker-b", 6, 60_000).map((item) => item.slug)).toEqual(["alpha"])
    database.close()
  })

  test("persists mirrored results and leaves an unchanged upstream item mirrored", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database, now: () => clock.value })
    const generation = store.beginGeneration(1)
    const list = listRecord("alpha", "1.0.0")
    store.recordPage(generation.id, 1, [list])
    store.claim("worker-a", 1, 60_000)

    expect(store.complete("worker-a", "alpha", completed("alpha"))).toBe(true)
    expect(store.mirroredEntries()).toEqual([completed("alpha").entry])
    store.recordPage(generation.id, 2, [list])
    expect(store.mirroredEntries()).toEqual([completed("alpha").entry])

    database.close()
  })

  test("records bounded errors, retries only current leases, and resumes a paused generation", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database, now: () => clock.value })
    const generation = store.beginGeneration(2)
    store.recordPage(generation.id, 1, [listRecord("retry", "1.0.0"), listRecord("reject", "1.0.0")])
    store.claim("worker-a", 2, 60_000)

    expect(store.retry("worker-b", "retry", "download", "wrong worker", clock.value + 60_000)).toBe(false)
    expect(store.retry("worker-a", "retry", "download", "temporary failure", clock.value + 60_000)).toBe(true)
    expect(
      database.connection
        .query<{ next_attempt_at: number; error_summary: string }, [string]>(
          "SELECT next_attempt_at, error_summary FROM skillhub_import_items WHERE slug = ?",
        )
        .get("retry"),
    ).toEqual({ next_attempt_at: clock.value + 60_000, error_summary: "temporary failure" })
    expect(store.reject("worker-a", "reject", "validation", "x".repeat(600))).toBe(true)
    expect(
      database.connection
        .query<{ error_summary: string }, [string]>("SELECT error_summary FROM skillhub_import_items WHERE slug = ?")
        .get("reject")?.error_summary,
    ).toHaveLength(500)

    store.command({ command: "pause" })
    expect(store.progress().state).toBe("paused")
    expect(store.command({ command: "resume" }).state).toBe("running")
    const transition = store.commandTransition({ command: "retry-rejected", slugs: ["reject"] })
    expect(transition.retriedRejected).toEqual([{ slug: "reject", code: "validation", summary: "x".repeat(500) }])
    expect(transition.progress.rejected).toBe(0)
    expect(
      database.connection
        .query<{ error_code: string | null; error_summary: string | null }, [string]>(
          "SELECT error_code, error_summary FROM skillhub_import_items WHERE slug = ?",
        )
        .get("reject"),
    ).toEqual({ error_code: null, error_summary: null })
    expect(store.progress().recentError).toEqual({
      code: "validation",
      summary: "x".repeat(500),
      occurredAt: new Date(clock.value).toISOString(),
    })

    database.close()
  })

  test("requeues a changed upstream record and tracks discovery sweep progress", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database, now: () => clock.value })
    const generation = store.beginGeneration(1)
    store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0")])
    store.claim("worker-a", 1, 60_000)
    store.complete("worker-a", "alpha", completed("alpha"))

    expect(store.completeSweep(generation.id)).toEqual({ stable: false })
    expect(store.activeGeneration()).toMatchObject({ discoveryPage: 0, sweep: 1, newInSweep: 0 })
    store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.1", 1_752_537_601_000)])
    expect(store.claim("worker-b", 1, 60_000).map((item) => item.upstreamVersion)).toEqual(["1.0.1"])
    expect(store.completeSweep(generation.id)).toEqual({ stable: true })
    expect(store.activeGeneration()).toBeUndefined()
    expect(store.progress()).toMatchObject({ state: "running", sourceStatus: "stale", discoveryPage: 1, sweep: 1 })
    expect(store.command({ command: "pause" }).state).toBe("paused")
    expect(store.command({ command: "resume" }).state).toBe("running")
    expect(store.complete("worker-b", "alpha", completed("alpha"))).toBe(true)
    expect(store.recordPublication(1)).toBe(true)
    expect(store.progress()).toMatchObject({
      state: "completed",
      sourceStatus: "fresh",
      lastPublishedAt: new Date(clock.value).toISOString(),
    })
    expect(
      database.connection
        .query<{ state: string }, [string]>("SELECT state FROM skillhub_generations WHERE id = ?")
        .get(generation.id)?.state,
    ).toBe("completed")

    database.close()
  })

  test("requires a complete no-new sweep before discovery is stable", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database, now: () => clock.value })
    const generation = store.beginGeneration(2)

    store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0"), listRecord("beta", "1.0.0")])
    expect(store.completeSweep(generation.id)).toEqual({ stable: false })
    store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0")], 2)
    expect(store.completeSweep(generation.id)).toEqual({ stable: false })
    expect(
      database.connection
        .query<{ state: string; upstream_version: string; last_seen_sweep: number }, [string]>(
          "SELECT state, upstream_version, last_seen_sweep FROM skillhub_import_items WHERE slug = ?",
        )
        .get("beta"),
    ).toEqual({ state: "pending", upstream_version: "1.0.0", last_seen_sweep: 0 })
    expect(store.activeGeneration()).toMatchObject({ discoveryPage: 0, sweep: 2, newInSweep: 0, upstreamTotal: 2 })
    store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0"), listRecord("beta", "1.0.0")])
    expect(store.completeSweep(generation.id)).toEqual({ stable: true })

    database.close()
  })

  test("requires a full resweep after legacy seeding", async () => {
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database })
    const legacy = completed("legacy").entry
    store.seedLegacy([{ slug: "legacy", ...legacy }])
    const generation = store.beginGeneration(1)
    const list = listRecord("legacy", "1.0.0", Date.parse(legacy.summary.updatedAt))

    store.recordPage(generation.id, 1, [list])
    expect(store.completeSweep(generation.id)).toEqual({ stable: false })
    store.recordPage(generation.id, 1, [list])
    expect(store.completeSweep(generation.id)).toEqual({ stable: true })
    database.close()
  })

  test("does not count cross-generation retries as discovery coverage", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database, now: () => clock.value })
    const generation = store.beginGeneration(2)
    store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0")])
    expect(store.completeSweep(generation.id)).toEqual({ stable: false })
    database.connection.run(
      "INSERT INTO skillhub_generations (id, state, upstream_total, started_at, updated_at, discovery_completed_at, completed_at) VALUES ('old', 'completed', 1, ?, ?, ?, ?)",
      [clock.value, clock.value, clock.value, clock.value],
    )
    database.connection.run(
      "INSERT INTO skillhub_import_items (slug, generation_id, upstream_version, upstream_updated_at, state, list_json, error_code, error_summary, last_seen_generation, last_seen_sweep, created_at, updated_at) VALUES ('beta', 'old', '1.0.0', 1, 'rejected', '{}', 'validation', 'old error', 'old', 1, ?, ?)",
      [clock.value, clock.value],
    )
    store.commandTransition({ command: "retry-rejected", slugs: ["beta"] })
    store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0")])

    expect(store.completeSweep(generation.id)).toEqual({ stable: false })
    expect(
      database.connection
        .query<{ state: string; last_seen_generation: string }, [string]>(
          "SELECT state, last_seen_generation FROM skillhub_import_items WHERE slug = ?",
        )
        .get("beta"),
    ).toEqual({ state: "pending", last_seen_generation: "old" })
    database.close()
  })

  test("keeps no-op legacy seeds and new generations on the publication checkpoint", async () => {
    const clock = { value: 1_752_537_600_000 }
    const fixture = await temporaryDatabaseFixture()
    const legacy = { slug: "legacy", ...completed("legacy").entry }
    const store = createSkillHubImportStore({ database: fixture.database, now: () => clock.value })
    expect(store.seedLegacy([legacy])).toBe(1)
    expect(store.recordPublication(1)).toBe(true)
    fixture.database.close()

    const reopened = await reopenDatabase(fixture)
    const resumed = createSkillHubImportStore({ database: reopened, now: () => clock.value })
    expect(resumed.seedLegacy([legacy])).toBe(0)
    expect(
      reopened.connection.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM skillhub_generations").get()?.count,
    ).toBe(1)
    expect(resumed.publicationCheckpoint()).toEqual({
      lastPublishedCount: 1,
      lastPublishedAt: new Date(clock.value).toISOString(),
    })
    expect(resumed.seedLegacy([legacy, { slug: "new-legacy", ...completed("new-legacy").entry }])).toBe(1)
    expect(
      reopened.connection.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM skillhub_generations",
      ).get()?.count,
    ).toBe(1)
    expect(
      reopened.connection.query<{ upstream_total: number }, []>(
        "SELECT upstream_total FROM skillhub_generations",
      ).get()?.upstream_total,
    ).toBe(2)
    expect(resumed.publicationCheckpoint()).toEqual({
      lastPublishedCount: 1,
      lastPublishedAt: new Date(clock.value).toISOString(),
    })
    resumed.beginGeneration(2)
    expect(resumed.publicationCheckpoint()).toEqual({
      lastPublishedCount: 1,
      lastPublishedAt: new Date(clock.value).toISOString(),
    })
    reopened.close()
  })

  test("carries the strongest historical publication checkpoint into a new generation", async () => {
    const database = await temporaryDatabase()
    database.connection.run(
      "INSERT INTO skillhub_generations (id, state, upstream_total, last_published_count, last_published_at, started_at, updated_at, discovery_completed_at, completed_at) VALUES ('older-strong', 'completed', 9, 9, 9, 1, 10, 10, 10), ('newer-weak', 'completed', 4, 4, 4, 2, 11, 11, 11)",
    )
    const store = createSkillHubImportStore({ database, now: () => 20 })

    const generation = store.beginGeneration(12)

    expect(
      database.connection
        .query<{ last_published_count: number; last_published_at: number }, [string]>(
          "SELECT last_published_count, last_published_at FROM skillhub_generations WHERE id = ?",
        )
        .get(generation.id),
    ).toEqual({ last_published_count: 9, last_published_at: 9 })
    expect(store.publicationCheckpoint()).toEqual({
      lastPublishedCount: 9,
      lastPublishedAt: new Date(9).toISOString(),
    })
    database.close()
  })

  test("validates claim bounds before mutating queue rows", async () => {
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database })
    const generation = store.beginGeneration(6)
    store.recordPage(
      generation.id,
      1,
      Array.from({ length: 6 }, (_, index) => listRecord(`skill-${index}`, "1.0.0")),
    )

    for (const input of [
      ["", 1, 60_000],
      ["x".repeat(129), 1, 60_000],
      ["worker", -1, 60_000],
      ["worker", 1.5, 60_000],
      ["worker", 7, 60_000],
      ["worker", 1, -1],
      ["worker", 1, 1.5],
      ["worker", 1, 86_400_001],
    ] as const)
      expect(() => store.claim(input[0], input[1], input[2])).toThrow()
    expect(store.progress()).toMatchObject({ pending: 6, running: 0 })
    expect(store.claim("worker", 6, 86_400_000)).toHaveLength(6)
    database.close()
  })

  test("claims disjoint bounded rows from overlapping processes", async () => {
    const fixture = await temporaryDatabaseFixture()
    const store = createSkillHubImportStore({ database: fixture.database })
    const generation = store.beginGeneration(6)
    store.recordPage(
      generation.id,
      1,
      Array.from({ length: 6 }, (_, index) => listRecord(`race-${index}`, "1.0.0")),
    )
    const barrier = join(fixture.path, "..", "claim-barrier")
    const worker = join(import.meta.dir, "skillhub-claim-race-worker.ts")
    const first = Bun.spawn([process.execPath, worker, fixture.path, "worker-a", barrier], { stdout: "pipe" })
    const second = Bun.spawn([process.execPath, worker, fixture.path, "worker-b", barrier], { stdout: "pipe" })
    await Bun.write(barrier, "go")
    const [firstOutput, secondOutput, firstExit, secondExit] = await Promise.all([
      new Response(first.stdout).json() as Promise<string[]>,
      new Response(second.stdout).json() as Promise<string[]>,
      first.exited,
      second.exited,
    ])

    expect([firstExit, secondExit]).toEqual([0, 0])
    expect(firstOutput).toHaveLength(3)
    expect(secondOutput).toHaveLength(3)
    expect(new Set([...firstOutput, ...secondOutput]).size).toBe(6)
    fixture.database.close()
  })

  test("adopts and refreshes one persisted unsettled generation after reopen", async () => {
    const clock = { value: 1_752_537_600_000 }
    const fixture = await temporaryDatabaseFixture()
    const generation = createSkillHubImportStore({ database: fixture.database, now: () => clock.value }).beginGeneration(2)
    fixture.database.close()

    clock.value += 1_000
    const reopened = await reopenDatabase(fixture)
    const store = createSkillHubImportStore({ database: reopened, now: () => clock.value })
    expect(store.beginGeneration(3)).toEqual(generation)
    expect(store.generationCheckpoint()).toMatchObject({
      id: generation.id,
      upstreamTotal: 3,
      discoveryCompleted: false,
    })
    expect(() => reopened.connection.run(
      "INSERT INTO skillhub_generations (id, state, upstream_total, started_at, updated_at) VALUES ('overlap', 'running', 0, ?, ?)",
      [clock.value, clock.value],
    )).toThrow()
    reopened.close()
  })

  test("persists a contiguous discovery cursor across reopen", async () => {
    const fixture = await temporaryDatabaseFixture()
    const store = createSkillHubImportStore({ database: fixture.database })
    const generation = store.beginGeneration(5)
    store.recordPage(generation.id, 1, [listRecord("one", "1.0.0")])
    store.recordPage(generation.id, 2, [listRecord("two", "1.0.0")])
    store.recordPage(generation.id, 3, [listRecord("three", "1.0.0")])
    store.recordPage(generation.id, 5, [listRecord("five", "1.0.0")])
    expect(store.activeGeneration()?.discoveryPage).toBe(3)
    fixture.database.close()

    const reopened = await reopenDatabase(fixture)
    const resumed = createSkillHubImportStore({ database: reopened })
    expect(resumed.activeGeneration()?.discoveryPage).toBe(3)
    resumed.recordPage(generation.id, 4, [listRecord("four", "1.0.0")])
    expect(resumed.activeGeneration()?.discoveryPage).toBe(4)
    resumed.recordPage(generation.id, 5, [listRecord("five", "1.0.0")])
    expect(resumed.activeGeneration()?.discoveryPage).toBe(5)
    reopened.close()
  })

  test("reopens a completed generation when selected rejected rows are retried", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database, now: () => clock.value })
    const generation = store.beginGeneration(1)
    store.recordPage(generation.id, 1, [listRecord("reject", "1.0.0")])
    store.completeSweep(generation.id)
    store.recordPage(generation.id, 1, [listRecord("reject", "1.0.0")])
    store.completeSweep(generation.id)
    store.claim("worker-a", 1, 60_000)
    store.reject("worker-a", "reject", "validation", "unsafe")
    expect(store.progress().state).toBe("completed")

    const transition = store.commandTransition({ command: "retry-rejected", slugs: ["reject"] })
    expect(transition.retriedRejected).toEqual([{ slug: "reject", code: "validation", summary: "unsafe" }])
    expect(store.generationCheckpoint()).toMatchObject({ state: "running", discoveryCompleted: true })
    expect(store.claim("worker-b", 1, 60_000).map((item) => item.slug)).toEqual(["reject"])
    expect(store.reject("worker-b", "reject", "validation", "still unsafe")).toBe(true)
    expect(store.progress().state).toBe("completed")
    database.close()
  })

  test("claims disjoint rows across independent connections and fences expired owners", async () => {
    const clock = { value: 1_752_537_600_000 }
    const fixture = await temporaryDatabaseFixture()
    const first = createSkillHubImportStore({ database: fixture.database, now: () => clock.value })
    const generation = first.beginGeneration(2)
    first.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0"), listRecord("beta", "1.0.0")])
    const secondDatabase = await reopenDatabase(fixture)
    const second = createSkillHubImportStore({ database: secondDatabase, now: () => clock.value })

    expect(first.claim("worker-a", 1, 60_000).map((item) => item.slug)).toEqual(["alpha"])
    expect(second.claim("worker-b", 1, 60_000).map((item) => item.slug)).toEqual(["beta"])
    clock.value += 60_001
    expect(second.claim("worker-c", 1, 60_000).map((item) => item.slug)).toEqual(["alpha"])
    expect(first.complete("worker-a", "alpha", completed("alpha"))).toBe(false)
    expect(first.retry("worker-a", "alpha", "download", "late", clock.value + 1)).toBe(false)
    expect(first.reject("worker-a", "alpha", "validation", "late")).toBe(false)
    secondDatabase.close()
    fixture.database.close()
  })

  test("persists retry boundaries, commands, leases, and publication checkpoints across reopen", async () => {
    const clock = { value: 1_752_537_600_000 }
    const fixture = await temporaryDatabaseFixture()
    const store = createSkillHubImportStore({ database: fixture.database, now: () => clock.value })
    const generation = store.beginGeneration(1)
    store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0")])
    store.claim("worker-a", 1, 60_000)
    store.retry("worker-a", "alpha", "download", "wait", clock.value + 10_000)
    expect(store.recordPublication(1)).toBe(true)
    expect(store.recordPublication(0)).toBe(false)
    expect(store.recordPublication(1.5)).toBe(false)
    fixture.database.close()

    const reopened = await reopenDatabase(fixture)
    const resumed = createSkillHubImportStore({ database: reopened, now: () => clock.value })
    expect(resumed.publicationCheckpoint()).toEqual({
      lastPublishedCount: 1,
      lastPublishedAt: new Date(clock.value).toISOString(),
    })
    expect(resumed.claim("early", 1, 60_000)).toEqual([])
    clock.value += 10_000
    expect(resumed.claim("boundary", 1, 60_000).map((item) => item.slug)).toEqual(["alpha"])
    resumed.retry("boundary", "alpha", "download", "again", clock.value + 10_000)
    expect(resumed.command({ command: "retry-wait" }).pending).toBe(1)
    expect(resumed.claim("command", 1, 60_000).map((item) => item.slug)).toEqual(["alpha"])
    reopened.close()

    const leaseReopened = await reopenDatabase(fixture)
    const leased = createSkillHubImportStore({ database: leaseReopened, now: () => clock.value })
    expect(leased.claim("before-expiry", 1, 60_000)).toEqual([])
    clock.value += 60_001
    expect(leased.claim("after-expiry", 1, 60_000).map((item) => item.slug)).toEqual(["alpha"])
    leaseReopened.close()
  })

  test("seeds legacy entries by authoritative slug and decodes persisted JSON schemas", async () => {
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database })
    const legacy = completed("public-id").entry
    expect(store.seedLegacy([{ slug: "owner/raw-skill", ...legacy }])).toBe(1)
    const generation = store.beginGeneration(1)
    expect(
      store.recordPage(generation.id, 1, [
        listRecord("owner/raw-skill", "1.0.0", Date.parse(legacy.summary.updatedAt)),
      ]).inserted,
    ).toBe(0)
    expect(store.claim("worker", 1, 60_000)).toEqual([])
    expect(database.connection.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM skillhub_import_items",
    ).get()?.count).toBe(1)
    database.connection.run("UPDATE skillhub_import_items SET summary_json = '{}' WHERE slug = ?", ["owner/raw-skill"])
    expect(() => store.mirroredEntries()).toThrow()

    database.connection.run(
      "UPDATE skillhub_import_items SET state = 'pending', summary_json = NULL, detail_key = NULL, detail_sha256 = NULL, mirrored_at = NULL, list_json = '{}' WHERE slug = ?",
      ["owner/raw-skill"],
    )
    expect(() => store.claim("invalid-json", 1, 60_000)).toThrow()
    database.close()
  })

  test("leaves malformed rejected rows untouched during selected retry", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database, now: () => clock.value })
    const generation = store.beginGeneration(1)
    database.connection.run("PRAGMA ignore_check_constraints = ON")
    database.connection.run(
      "INSERT INTO skillhub_import_items (slug, generation_id, upstream_version, upstream_updated_at, state, list_json, last_seen_generation, created_at, updated_at) VALUES ('malformed', ?, '1', 1, 'rejected', '{}', ?, ?, ?)",
      [generation.id, generation.id, clock.value, clock.value],
    )
    database.connection.run("PRAGMA ignore_check_constraints = OFF")

    expect(store.commandTransition({ command: "retry-rejected", slugs: ["malformed"] }).retriedRejected).toEqual([])
    expect(
      database.connection
        .query<{ state: string }, [string]>("SELECT state FROM skillhub_import_items WHERE slug = ?")
        .get("malformed")?.state,
    ).toBe("rejected")
    database.close()
  })

  test("enforces queue state invariants and computes a rolling completion rate", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    const store = createSkillHubImportStore({ database, now: () => clock.value })
    const generation = store.beginGeneration(3)
    expect(() => database.connection.run(
      "INSERT INTO skillhub_import_items (slug, generation_id, upstream_version, upstream_updated_at, state, list_json, last_seen_generation, created_at, updated_at) VALUES ('bad-running', ?, '1', 1, 'running', '{}', ?, ?, ?)",
      [generation.id, generation.id, clock.value, clock.value],
    )).toThrow()
    expect(() => database.connection.run(
      "INSERT INTO skillhub_import_items (slug, generation_id, upstream_version, upstream_updated_at, state, list_json, last_seen_generation, created_at, updated_at) VALUES ('bad-retry', ?, '1', 1, 'retry_wait', '{}', ?, ?, ?)",
      [generation.id, generation.id, clock.value, clock.value],
    )).toThrow()
    expect(() => database.connection.run(
      "INSERT INTO skillhub_import_items (slug, generation_id, upstream_version, upstream_updated_at, state, list_json, last_seen_generation, created_at, updated_at) VALUES ('bad-mirror', ?, '1', 1, 'mirrored', '{}', ?, ?, ?)",
      [generation.id, generation.id, clock.value, clock.value],
    )).toThrow()

    store.recordPage(generation.id, 1, [
      listRecord("alpha", "1.0.0"),
      listRecord("beta", "1.0.0"),
      listRecord("gamma", "1.0.0"),
    ])
    store.claim("worker", 2, 60_000)
    store.complete("worker", "alpha", completed("alpha"))
    clock.value += 30_000
    store.complete("worker", "beta", completed("beta"))
    expect(store.progress()).toMatchObject({ ratePerMinute: 2, estimatedSecondsRemaining: 30 })
    clock.value += 30_001
    expect(store.progress()).toMatchObject({ ratePerMinute: 1, estimatedSecondsRemaining: 60 })
    database.close()
  })
})

function listRecord(slug: string, version: string, updatedAt = 1_752_537_600_000): SkillHubListRecord {
  return {
    category: "tools",
    description: `${slug} description`,
    downloads: 1,
    installs: 1,
    name: slug,
    ownerName: "owner",
    score: 1,
    slug,
    source: "https://example.com/source",
    stars: 1,
    subCategories: [],
    updated_at: updatedAt,
    version,
  }
}

function completed(slug: string) {
  const detail = sampleDetail({ id: slug, name: slug, version: "1.0.0" })
  return {
    entry: {
      summary: {
        id: detail.id,
        source: detail.source,
        sourceUrl: detail.sourceUrl,
        name: detail.name,
        description: detail.description,
        categories: detail.categories,
        tags: detail.tags,
        requiresApiKey: detail.requiresApiKey,
        risk: detail.risk,
        version: detail.version,
        updatedAt: detail.updatedAt,
        downloads: detail.downloads,
        favorites: detail.favorites,
        score: detail.score,
        featured: detail.featured,
        enterprise: detail.enterprise,
        delisted: detail.delisted,
      },
      detailKey: `details/${slug}.json`,
      detailSha256: "c".repeat(64),
    },
    record: {
      slug,
      name: slug,
      description: "description",
      categories: [],
      tags: [],
      requiresApiKey: false,
      risk: "safe",
      version: "1.0.0",
      updatedAt: "2026-07-17T00:00:00.000Z",
      downloads: 1,
      favorites: 1,
      score: 1,
      sourceUrl: "https://example.com/source",
      publicDetailUrl: "https://example.com/detail",
      author: { name: "owner" },
      files: [],
      versions: [],
      securityReports: [],
      downloadUrl: "https://example.com/download",
    } satisfies SkillHubRecord,
    originalPackageSha256: "a".repeat(64),
    packageSha256: "b".repeat(64),
    packageSize: 2_000,
    repairs: [],
  }
}

async function temporaryDatabase() {
  return (await temporaryDatabaseFixture()).database
}

async function temporaryDatabaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-store-"))
  directories.push(directory)
  const path = join(directory, "market.db")
  const backups = join(directory, "backups")
  return {
    database: await openDatabase({
      databasePath: path,
      migrationBackupDirectory: backups,
    }),
    path,
    backups,
  }
}

function reopenDatabase(fixture: { readonly path: string; readonly backups: string }) {
  return openDatabase({
    databasePath: fixture.path,
    migrationBackupDirectory: fixture.backups,
  })
}
