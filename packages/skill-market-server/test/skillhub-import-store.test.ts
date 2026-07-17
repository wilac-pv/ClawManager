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
      upstreamTotal: 78_253,
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
    expect(store.activeGeneration()).toMatchObject({ discoveryPage: 0, sweep: 2, newInSweep: 0, upstreamTotal: 2 })
    store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0"), listRecord("beta", "1.0.0")])
    expect(store.completeSweep(generation.id)).toEqual({ stable: true })

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
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-store-"))
  directories.push(directory)
  return openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
}
