import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { createSkillHubEvaluationStore } from "../src/skillhub-evaluation-store"
import { sampleDetail } from "./fixture"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("SkillHub evaluation store", () => {
  test("claims a FIFO batch of at most two mirrored items", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    seed(database, clock.value, ["a", "b", "c"])
    const store = createSkillHubEvaluationStore({ database, now: () => clock.value })

    expect(store.claim("worker-a", 2, 60_000).map((item) => item.slug)).toEqual(["a", "b"])
    expect(store.claim("worker-b", 2, 60_000).map((item) => item.slug)).toEqual(["c"])
    expect(() => store.claim("worker-c", 3, 60_000)).toThrow("between 1 and 2")
    database.close()
  })

  test("renews only an active worker lease and fences a stale worker", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    seed(database, clock.value, ["a"])
    const store = createSkillHubEvaluationStore({ database, now: () => clock.value })
    store.claim("worker-a", 1, 60_000)

    expect(store.renew("worker-b", "a", 60_000)).toBe(false)
    expect(store.renew("worker-a", "a", 60_000)).toBe(true)
    clock.value += 60_001
    expect(store.claim("worker-b", 1, 60_000).map((item) => item.slug)).toEqual(["a"])
    expect(store.complete("worker-a", "a", evaluation)).toBe(false)
    expect(store.complete("worker-b", "a", evaluation)).toBe(true)
    database.close()
  })

  test("completes an evaluation with all scores and preserves the decoded summary", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    seed(database, clock.value, ["a"])
    const store = createSkillHubEvaluationStore({ database, now: () => clock.value })
    store.claim("worker-a", 1, 60_000)

    expect(store.complete("worker-a", "a", evaluation)).toBe(true)
    expect(
      database.connection
        .query<{
          readonly evaluation_state: string
          readonly evaluation_score: number
          readonly evaluation_trust: number
          readonly evaluation_reliability: number
          readonly evaluation_adaptability: number
          readonly evaluation_convention: number
          readonly evaluation_effectiveness: number
          readonly evaluation_checked_at: number
          readonly evaluation_lease_owner: string | null
          readonly evaluation_lease_expires_at: number | null
          readonly evaluation_next_attempt_at: number | null
          readonly evaluation_error_summary: string | null
          readonly summary_json: string
        }, [string]>(
          "SELECT evaluation_state, evaluation_score, evaluation_trust, evaluation_reliability, evaluation_adaptability, evaluation_convention, evaluation_effectiveness, evaluation_checked_at, evaluation_lease_owner, evaluation_lease_expires_at, evaluation_next_attempt_at, evaluation_error_summary, summary_json FROM skillhub_import_items WHERE slug = ?",
        )
        .get("a"),
    ).toMatchObject({
      evaluation_state: "completed",
      evaluation_score: 4.45,
      evaluation_trust: 5,
      evaluation_reliability: 4,
      evaluation_adaptability: 4.3,
      evaluation_convention: 4.325,
      evaluation_effectiveness: 4.625,
      evaluation_checked_at: clock.value,
      evaluation_lease_owner: null,
      evaluation_lease_expires_at: null,
      evaluation_next_attempt_at: null,
      evaluation_error_summary: null,
    })
    const summary = JSON.parse(
      database.connection.query<{ readonly summary_json: string }, [string]>("SELECT summary_json FROM skillhub_import_items WHERE slug = ?").get("a")!
        .summary_json,
    )
    expect(summary).toMatchObject({
      id: "a",
      score: 9.5,
      evaluationScore: 4.45,
      traceEvaluation: {
        trust: evaluation.trust,
        reliability: evaluation.reliability,
        adaptability: evaluation.adaptability,
        convention: evaluation.convention,
        effectiveness: evaluation.effectiveness,
        evaluatedAt: new Date(clock.value).toISOString(),
      },
    })
    database.close()
  })

  test("uses capped exponential retry and fails at the configured attempt limit", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    seed(database, clock.value, ["a"])
    const store = createSkillHubEvaluationStore({ database, now: () => clock.value })
    store.claim("worker-a", 1, 60_000)

    expect(store.retry("worker-a", "a", "x".repeat(600), { maximumAttempts: 3, baseDelayMilliseconds: 1_000, maximumDelayMilliseconds: 3_000 })).toBe(true)
    expect(row(database, "a")).toMatchObject({
      evaluation_state: "retry_wait",
      evaluation_next_attempt_at: clock.value + 1_000,
      evaluation_error_summary: "x".repeat(500),
    })
    clock.value += 1_000
    store.claim("worker-a", 1, 60_000)
    expect(store.retry("worker-a", "a", "second", { maximumAttempts: 3, baseDelayMilliseconds: 1_000, maximumDelayMilliseconds: 3_000 })).toBe(true)
    expect(row(database, "a")).toMatchObject({ evaluation_state: "retry_wait", evaluation_next_attempt_at: clock.value + 2_000 })
    clock.value += 2_000
    store.claim("worker-a", 1, 60_000)
    expect(store.retry("worker-a", "a", "third", { maximumAttempts: 3, baseDelayMilliseconds: 1_000, maximumDelayMilliseconds: 3_000 })).toBe(true)
    expect(row(database, "a")).toMatchObject({
      evaluation_state: "failed",
      evaluation_next_attempt_at: null,
      evaluation_lease_owner: null,
      evaluation_error_summary: "third",
    })
    database.close()
  })

  test("refreshes a completed evaluation with a fresh retry budget", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    seed(database, clock.value, ["a"])
    const store = createSkillHubEvaluationStore({ database, now: () => clock.value })
    const policy = { maximumAttempts: 3, baseDelayMilliseconds: 1_000, maximumDelayMilliseconds: 3_000 }

    store.claim("worker-a", 1, 60_000)
    store.retry("worker-a", "a", "first", policy)
    clock.value += 1_000
    store.claim("worker-a", 1, 60_000)
    store.retry("worker-a", "a", "second", policy)
    clock.value += 2_000
    store.claim("worker-a", 1, 60_000)
    expect(store.complete("worker-a", "a", evaluation)).toBe(true)

    clock.value += 7 * 24 * 60 * 60 * 1_000
    expect(store.markDue()).toBe(1)
    expect(store.claim("worker-b", 1, 60_000)).toEqual([{ slug: "a", attempts: 1 }])
    expect(store.retry("worker-b", "a", "refresh failed", policy)).toBe(true)
    expect(row(database, "a")).toMatchObject({ evaluation_state: "retry_wait", evaluation_next_attempt_at: clock.value + 1_000 })
    database.close()
  })

  test("recovers expired leases, refreshes completed evaluations after seven days, and reports aggregate progress", async () => {
    const clock = { value: 1_752_537_600_000 }
    const database = await temporaryDatabase()
    seed(database, clock.value, ["a", "b", "c", "d"])
    const store = createSkillHubEvaluationStore({ database, now: () => clock.value })
    store.claim("worker-a", 2, 60_000)
    store.complete("worker-a", "a", evaluation)
    store.retry("worker-a", "b", "temporary", { maximumAttempts: 4, baseDelayMilliseconds: 120_000, maximumDelayMilliseconds: 120_000 })
    store.claim("worker-a", 2, 60_000)

    expect(store.progress()).toMatchObject({ total: 4, waiting: 0, pending: 0, running: 2, retryWait: 1, completed: 1, failed: 0, ratePerMinute: 1, estimatedSecondsRemaining: 180, recentError: "temporary" })
    clock.value += 60_001
    expect(store.claim("worker-b", 2, 60_000).map((item) => item.slug)).toEqual(["c", "d"])
    expect(store.complete("worker-b", "c", evaluation)).toBe(true)
    clock.value += 7 * 24 * 60 * 60 * 1_000
    expect(store.markDue()).toBe(2)
    expect(row(database, "a")).toMatchObject({ evaluation_state: "pending", evaluation_score: 4.45 })
    expect(row(database, "c")).toMatchObject({ evaluation_state: "pending", evaluation_score: 4.45 })
    database.close()
  })
})

const evaluation = {
  trust: 5,
  reliability: 4,
  adaptability: 4.3,
  convention: 4.325,
  effectiveness: 4.625,
  score: 4.45,
} as const

function seed(database: Awaited<ReturnType<typeof temporaryDatabase>>, timestamp: number, slugs: readonly string[]) {
  database.connection.run(
    "INSERT INTO skillhub_generations (id, state, upstream_total, started_at, updated_at, discovery_completed_at, completed_at) VALUES ('generation', 'completed', ?, ?, ?, ?, ?)",
    [slugs.length, timestamp, timestamp, timestamp, timestamp],
  )
  slugs.forEach((slug) => {
    const detail = sampleDetail({ id: slug, name: slug })
    database.connection.run(
      "INSERT INTO skillhub_import_items (slug, generation_id, upstream_version, upstream_updated_at, state, list_json, summary_json, detail_key, detail_sha256, mirrored_at, last_seen_generation, created_at, updated_at, evaluation_state) VALUES (?, 'generation', '1.0.0', ?, 'mirrored', '{}', ?, ?, ?, ?, 'generation', ?, ?, 'pending')",
      [slug, timestamp, JSON.stringify({ ...detail, readme: undefined, author: undefined, versions: undefined, securityReports: undefined, package: undefined, publicDetailUrl: undefined }), `details/${slug}.json`, "a".repeat(64), timestamp, timestamp, timestamp],
    )
  })
}

function row(database: Awaited<ReturnType<typeof temporaryDatabase>>, slug: string) {
  return database.connection
    .query<{
      readonly evaluation_state: string
      readonly evaluation_score: number | null
      readonly evaluation_next_attempt_at: number | null
      readonly evaluation_lease_owner: string | null
      readonly evaluation_error_summary: string | null
    }, [string]>(
      "SELECT evaluation_state, evaluation_score, evaluation_next_attempt_at, evaluation_lease_owner, evaluation_error_summary FROM skillhub_import_items WHERE slug = ?",
    )
    .get(slug)
}

async function temporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-evaluation-"))
  directories.push(directory)
  return openDatabase({ databasePath: join(directory, "market.db"), migrationBackupDirectory: join(directory, "backups") })
}
