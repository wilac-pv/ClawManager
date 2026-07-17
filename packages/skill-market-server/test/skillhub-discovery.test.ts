import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAdaptivePool } from "../src/adaptive-pool"
import { openDatabase } from "../src/database"
import { discoverSkillHub } from "../src/skillhub-discovery"
import { createSkillHubImportStore } from "../src/skillhub-import-store"
import { loadSkillHubPage, type SkillHubListRecord } from "../src/skillhub"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("SkillHub discovery", () => {
  test("reads 801 records in bounded page batches then performs a stable resweep", async () => {
    const database = await temporaryDatabase()
    const imports = createSkillHubImportStore({ database })
    const state = { active: 0, maximumActive: 0 }
    const records = Array.from({ length: 801 }, (_, index) => listRecord(`skill-${index}`))
    const result = await discoverSkillHub({
      fetcher: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"))
        state.active += 1
        state.maximumActive = Math.max(state.maximumActive, state.active)
        await Promise.resolve()
        state.active -= 1
        return pageResponse(records.slice((page - 1) * 100, page * 100), records.length)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
      pageConcurrency: 4,
    })

    expect(result).toMatchObject({ discovered: 801, completed: true })
    expect(state.maximumActive).toBeLessThanOrEqual(4)
    expect(imports.generationCheckpoint()?.discoveryCompleted).toBe(true)
    database.close()
  })

  test("keeps the cursor behind a failed page and resumes that gap after reopen", async () => {
    const fixture = await temporaryDatabaseFixture()
    const first = createSkillHubImportStore({ database: fixture.database })
    let pageFourFetched = false
    await expect(
      discoverSkillHub({
        fetcher: async (input) => {
          const page = Number(new URL(String(input)).searchParams.get("page"))
          if (page === 3) {
            while (!pageFourFetched) await Promise.resolve()
            return new Response("broken", { status: 400 })
          }
          if (page === 4) pageFourFetched = true
          return pageResponse(pageRecords(page), 301)
        },
        baseUrl: "https://api.skillhub.cn",
        imports: first,
        pageConcurrency: 4,
      }),
    ).rejects.toThrow("400")
    expect(first.activeGeneration()?.discoveryPage).toBe(2)
    fixture.database.close()

    const resumedDatabase = await reopenDatabase(fixture)
    const resumed = createSkillHubImportStore({ database: resumedDatabase })
    const result = await discoverSkillHub({
      fetcher: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"))
        return pageResponse(pageRecords(page), 301)
      },
      baseUrl: "https://api.skillhub.cn",
      imports: resumed,
      pageConcurrency: 4,
    })

    expect(result).toMatchObject({ discovered: 301, completed: true })
    expect(resumed.activeGeneration()).toBeUndefined()
    resumedDatabase.close()
  })

  test("backs off after throttling and recovers one slot after five quiet minutes", async () => {
    const clock = { value: 0 }
    const waits: number[] = []
    const pool = createAdaptivePool({
      minimum: 1,
      maximum: 4,
      now: () => clock.value,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
        clock.value += milliseconds
      },
    })
    let attempts = 0
    const result = await pool.map(["page"], async () => {
      attempts += 1
      if (attempts === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
      return new Response("ok")
    })

    expect(result[0]?.status).toBe(200)
    expect(attempts).toBe(2)
    expect(waits).toEqual([1_000])
    expect(pool.concurrency()).toBe(2)
    clock.value += 5 * 60_000
    expect(pool.concurrency()).toBe(3)
  })

  test("honors HTTP-date Retry-After values", async () => {
    const clock = { value: Date.parse("2026-07-17T00:00:00.000Z") }
    const waits: number[] = []
    const pool = createAdaptivePool({
      minimum: 1,
      maximum: 4,
      now: () => clock.value,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
        clock.value += milliseconds
      },
    })
    let attempts = 0
    await pool.map(["page"], async () => {
      attempts += 1
      return attempts === 1
        ? new Response("later", { status: 429, headers: { "retry-after": "Thu, 17 Jul 2026 00:00:02 GMT" } })
        : new Response("ok")
    })
    expect(waits).toEqual([2_000])
  })

  test("retries and throttles the initial page observation", async () => {
    const database = await temporaryDatabase()
    const imports = createSkillHubImportStore({ database })
    const clock = { value: 0 }
    const waits: number[] = []
    let calls = 0
    const result = await discoverSkillHub({
      fetcher: async () => {
        calls += 1
        return calls === 1
          ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
          : pageResponse([listRecord("initial")], 1)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
      now: () => clock.value,
      wait: async (milliseconds) => {
        waits.push(milliseconds)
        clock.value += milliseconds
      },
    })

    expect(result).toMatchObject({ completed: true, pageConcurrency: 2 })
    expect(calls).toBe(3)
    expect(waits).toEqual([1_000])
    database.close()
  })

  test("does not retry permanent response or schema failures", async () => {
    const pool = createAdaptivePool({ minimum: 1, maximum: 4, wait: async () => {} })
    let attempts = 0
    await expect(
      pool.map(["page"], async () => {
        attempts += 1
        return new Response("bad request", { status: 400 })
      }),
    ).rejects.toThrow("400")
    expect(attempts).toBe(1)
  })

  test("does not retry arbitrary application errors", async () => {
    const pool = createAdaptivePool({ minimum: 1, maximum: 4, wait: async () => {} })
    let attempts = 0
    await expect(
      pool.map(["page"], async () => {
        attempts += 1
        throw new Error("application invariant failed")
      }),
    ).rejects.toThrow("application invariant")
    expect(attempts).toBe(1)
  })

  test("retries upstream server failures", async () => {
    const pool = createAdaptivePool({ minimum: 1, maximum: 4, wait: async () => {} })
    let attempts = 0
    const output = await pool.map(["page"], async () => {
      attempts += 1
      return attempts === 1 ? new Response("unavailable", { status: 503 }) : new Response("ok")
    })
    expect(output[0]?.status).toBe(200)
    expect(attempts).toBe(2)
  })

  test("halves concurrency after repeated network timeouts", async () => {
    const pool = createAdaptivePool({ minimum: 1, maximum: 4, wait: async () => {} })
    let attempts = 0
    const output = await pool.map(["page"], async () => {
      attempts += 1
      if (attempts < 3) throw new TypeError("timed out")
      return "ok"
    })

    expect(output).toEqual(["ok"])
    expect(pool.concurrency()).toBe(2)
  })

  test("does not retry schema decoding failures from the page adapter", async () => {
    let calls = 0
    const pool = createAdaptivePool({ minimum: 1, maximum: 4, wait: async () => {} })
    await expect(
      pool.map([1], async () => {
        calls += 1
        return loadSkillHubPage(async () => new Response("{}"), "https://api.skillhub.cn", 1)
      }),
    ).rejects.toThrow("schema")
    expect(calls).toBe(1)
  })

  test("does no upstream work while paused or after discovery completes", async () => {
    const database = await temporaryDatabase()
    const imports = createSkillHubImportStore({ database })
    const generation = imports.beginGeneration(1)
    imports.command({ command: "pause" })
    let calls = 0
    await expect(
      discoverSkillHub({
        fetcher: async () => {
          calls += 1
          return pageResponse([listRecord("paused")], 1)
        },
        baseUrl: "https://api.skillhub.cn",
        imports,
      }),
    ).resolves.toMatchObject({ discovered: 0, completed: false })
    expect(calls).toBe(0)
    imports.command({ command: "resume" })
    imports.recordPage(generation.id, 1, [listRecord("done")])
    imports.completeSweep(generation.id)
    imports.recordPage(generation.id, 1, [listRecord("done")])
    imports.completeSweep(generation.id)
    await discoverSkillHub({
      fetcher: async () => {
        calls += 1
        return pageResponse([listRecord("unexpected")], 1)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
    })
    expect(calls).toBe(0)
    database.close()
  })

  test("returns stale after three unstable sweep completions without delisting records", async () => {
    const database = await temporaryDatabase()
    const imports = createSkillHubImportStore({ database })
    let sweep = 0
    const result = await discoverSkillHub({
      fetcher: async () => {
        sweep += 1
        return pageResponse([listRecord(`moving-${sweep}`)], 1)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
    })

    expect(result).toMatchObject({ discovered: 3, completed: false, stale: true })
    expect(imports.activeGeneration()).toMatchObject({ sweep: 3, discoveryPage: 0 })
    expect(imports.progress().discovered).toBe(3)
    database.close()
  })
})

function pageResponse(skills: readonly SkillHubListRecord[], total: number) {
  return new Response(JSON.stringify({ code: 0, data: { skills, total }, message: "ok" }))
}

function listRecord(slug: string): SkillHubListRecord {
  return {
    category: "tools",
    description: slug,
    downloads: 1,
    installs: 1,
    name: slug,
    ownerName: "owner",
    score: 1,
    slug,
    source: "https://example.com/source",
    stars: 1,
    subCategories: [],
    updated_at: 1_752_537_600_000,
    version: "1.0.0",
  }
}

function pageRecords(page: number) {
  return Array.from({ length: page === 4 ? 1 : 100 }, (_, index) => listRecord(`skill-${page}-${index}`))
}

async function temporaryDatabase() {
  return (await temporaryDatabaseFixture()).database
}

async function temporaryDatabaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-discovery-"))
  directories.push(directory)
  const path = join(directory, "market.db")
  const backups = join(directory, "backups")
  return {
    database: await openDatabase({ databasePath: path, migrationBackupDirectory: backups }),
    path,
    backups,
  }
}

function reopenDatabase(fixture: { readonly path: string; readonly backups: string }) {
  return openDatabase({ databasePath: fixture.path, migrationBackupDirectory: fixture.backups })
}
