import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AdaptivePoolError, createAdaptivePool } from "../src/adaptive-pool"
import { openDatabase, SqliteDatabase } from "../src/database"
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
        if (page % 4 === 2) await new Promise((resolve) => setTimeout(resolve, 5))
        state.active -= 1
        return pageResponse(records.slice((page - 1) * 100, page * 100), records.length)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
      pageConcurrency: 4,
    })

    expect(result).toMatchObject({ discovered: 801, completed: true })
    expect(state.maximumActive).toBeLessThanOrEqual(4)
    expect((await imports.generationCheckpoint())?.discoveryCompleted).toBe(true)
    await database.close()
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
    expect((await first.activeGeneration())?.discoveryPage).toBe(1)
    await fixture.database.close()

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
    expect(await resumed.activeGeneration()).toBeUndefined()
    await resumedDatabase.close()
  })

  test("backs off after throttling then recovers one stable p95 slot per minute", async () => {
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
    for (let index = 0; index < 5; index += 1) await pool.map([index], async () => new Response("ok"))
    expect(pool.concurrency()).toBe(2)
    clock.value += 5 * 60_000
    expect(pool.concurrency()).toBe(3)
    clock.value += 60_000
    expect(pool.concurrency()).toBe(4)
    clock.value += 60_000
    expect(pool.concurrency()).toBe(4)
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

  test("requires a stable p95 observation before recovering concurrency", async () => {
    const clock = { value: 0 }
    const pool = createAdaptivePool({
      minimum: 1,
      maximum: 4,
      now: () => clock.value,
      wait: async () => {},
    })
    let attempts = 0
    await pool.map(["page"], async () => {
      attempts += 1
      if (attempts === 1) return new Response("slow down", { status: 429 })
      clock.value += 1_001
      return new Response("ok")
    })

    clock.value = 5 * 60_000
    expect(pool.concurrency()).toBe(2)
  })

  test("recovers after stable slow p95 observations", async () => {
    const clock = { value: 0 }
    const pool = createAdaptivePool({
      minimum: 1,
      maximum: 4,
      now: () => clock.value,
      wait: async () => {},
    })
    let attempts = 0
    await pool.map(["first"], async () => {
      attempts += 1
      if (attempts === 1) return new Response("slow down", { status: 429 })
      clock.value += 1_500
      return new Response("ok")
    })
    for (let index = 0; index < 5; index += 1)
      await pool.map([index], async () => {
        clock.value += 1_500
        return new Response("ok")
      })

    clock.value = 5 * 60_000
    expect(pool.concurrency()).toBe(3)
  })

  test("does not recover after a rolling p95 latency jump", async () => {
    const clock = { value: 0 }
    const pool = createAdaptivePool({
      minimum: 1,
      maximum: 4,
      now: () => clock.value,
      wait: async () => {},
    })
    let attempts = 0
    for (const latency of [100, 100, 100, 100, 900, 900, 900])
      await pool.map([latency], async () => {
        attempts += 1
        if (attempts === 1) return new Response("slow down", { status: 429 })
        clock.value += latency
        return new Response("ok")
      })

    clock.value = 5 * 60_000
    expect(pool.concurrency()).toBe(2)
  })

  test("starts recovery at one slot when p95 becomes stable after minute eight", async () => {
    const clock = { value: 0 }
    const pool = createAdaptivePool({
      minimum: 1,
      maximum: 4,
      now: () => clock.value,
      wait: async () => {},
    })
    let attempts = 0
    for (const latency of [100, 100, 100, 100, 900, 900, 900])
      await pool.map([latency], async () => {
        attempts += 1
        if (attempts === 1) return new Response("slow down", { status: 429 })
        clock.value += latency
        return new Response("ok")
      })

    clock.value = 5 * 60_000
    expect(pool.concurrency()).toBe(2)
    clock.value = 8 * 60_000
    for (let index = 0; index < 3; index += 1)
      await pool.map([index], async () => {
        clock.value += 900
        return new Response("ok")
      })

    expect(pool.concurrency()).toBe(3)
    clock.value += 60_000
    expect(pool.concurrency()).toBe(4)
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
    await database.close()
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

  test("does not retry arbitrary programmer TypeErrors", async () => {
    const pool = createAdaptivePool({ minimum: 1, maximum: 4, wait: async () => {} })
    let attempts = 0
    await expect(
      pool.map(["page"], async () => {
        attempts += 1
        throw new TypeError("cannot read properties of undefined")
      }),
    ).rejects.toThrow("cannot read")
    expect(attempts).toBe(1)
  })

  test("tags rejected fetches as transient while leaving run TypeErrors permanent", async () => {
    const pool = createAdaptivePool({ minimum: 1, maximum: 4, wait: async () => {} })
    let calls = 0
    const [page] = await pool.map([1], (number) =>
      loadSkillHubPage(async () => {
        calls += 1
        if (calls === 1) throw new TypeError("socket reset")
        return pageResponse([listRecord("network")], 1)
      }, "https://api.skillhub.cn", number),
    )
    expect(page.data.total).toBe(1)
    expect(calls).toBe(2)
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
      if (attempts < 3) throw new AdaptivePoolError("timed out")
      return "ok"
    })

    expect(output).toEqual(["ok"])
    expect(pool.concurrency()).toBe(2)
  })

  test("stops scheduling after a paused multi-batch sweep", async () => {
    const database = await temporaryDatabase()
    const imports = createSkillHubImportStore({ database })
    const calls: number[] = []
    await discoverSkillHub({
      fetcher: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"))
        calls.push(page)
        if (page === 2) await imports.command({ command: "pause" })
        return pageResponse(pageRecordsOf100(page), 900)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
      pageConcurrency: 4,
    })

    expect(calls).toEqual([1, 2, 3, 4, 5])
    expect(await imports.generationCheckpoint()).toMatchObject({ state: "paused", discoveryPage: 5 })
    await database.close()
  })

  test("expands a sweep for late higher totals without lowering persisted coverage", async () => {
    const database = await temporaryDatabase()
    const imports = createSkillHubImportStore({ database })
    const calls: number[] = []
    const result = await discoverSkillHub({
      fetcher: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"))
        calls.push(page)
        if (page === 1) return pageResponse(pageRecordsOf100(page), 300)
        if (page === 2) {
          await Promise.resolve()
          return pageResponse(pageRecordsOf100(page), 200)
        }
        return pageResponse(pageRecordsOf100(page), 500)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
      pageConcurrency: 2,
    })

    expect(result).toMatchObject({ discovered: 500, completed: true })
    expect(calls).toContain(4)
    expect(calls).toContain(5)
    expect(await imports.generationCheckpoint()).toMatchObject({ upstreamTotal: 500, discoveryCompleted: true })
    await database.close()
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
    const generation = await imports.beginGeneration(1)
    await imports.command({ command: "pause" })
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
    await imports.command({ command: "resume" })
    await imports.recordPage(generation.id, 1, [listRecord("done")])
    await imports.completeSweep(generation.id)
    await imports.recordPage(generation.id, 1, [listRecord("done")])
    await imports.completeSweep(generation.id)
    await discoverSkillHub({
      fetcher: async () => {
        calls += 1
        return pageResponse([listRecord("unexpected")], 1)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
    })
    expect(calls).toBe(0)
    await database.close()
  })

  test("uses a configured limit as the effective total, then refreshes a completed canary into the full upstream total", async () => {
    const database = await temporaryDatabase()
    const imports = createSkillHubImportStore({ database })
    const records = [listRecord("canary"), listRecord("full")]
    const first = await discoverSkillHub({
      fetcher: async () => pageResponse(records, records.length),
      baseUrl: "https://api.skillhub.cn",
      imports,
      limit: 1,
    })

    expect(first).toMatchObject({ discovered: 1, completed: true })
    expect(await imports.progress()).toMatchObject({ upstreamTotal: 1, pending: 1 })
    await imports.claim("canary-worker", 1, 60_000)
    await imports.reject("canary-worker", "canary", "validation", "canary complete")
    expect((await imports.progress()).state).toBe("completed")

    const full = await discoverSkillHub({
      fetcher: async () => pageResponse(records, records.length),
      baseUrl: "https://api.skillhub.cn",
      imports,
      refresh: true,
    })

    expect(full).toMatchObject({ discovered: 2, completed: true })
    expect(await imports.progress()).toMatchObject({ upstreamTotal: 2, pending: 1 })
    await database.close()
  })

  test("expands a completed generation when the configured canary limit increases", async () => {
    const database = await temporaryDatabase()
    const imports = createSkillHubImportStore({ database })
    const records = [listRecord("first"), listRecord("second")]
    await discoverSkillHub({
      fetcher: async () => pageResponse(records, records.length),
      baseUrl: "https://api.skillhub.cn",
      imports,
      limit: 1,
    })
    await imports.claim("first-worker", 1, 60_000)
    await imports.reject("first-worker", "first", "validation", "first canary complete")

    const expanded = await discoverSkillHub({
      fetcher: async () => pageResponse(records, records.length),
      baseUrl: "https://api.skillhub.cn",
      imports,
      limit: 2,
    })

    expect(expanded).toMatchObject({ discovered: 2, completed: true })
    expect(await imports.progress()).toMatchObject({ upstreamTotal: 2, pending: 1 })
    await database.close()
  })

  test("only refreshes a completed generation when the effective upstream total changes", async () => {
    const database = await temporaryDatabase()
    const imports = createSkillHubImportStore({ database, packageConcurrency: 200 })
    const records = Array.from({ length: 200 }, (_, index) => listRecord(`skill-${index}`))
    const generations = () =>
      (database as SqliteDatabase).connection.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM skillhub_generations").get()!.count
    const fetcher = async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get("page"))
      return pageResponse(records.slice((page - 1) * 100, page * 100), records.length)
    }

    await discoverSkillHub({ fetcher, baseUrl: "https://api.skillhub.cn", imports, limit: 100 })
    for (const item of await imports.claim("canary-worker", 100, 60_000))
      await imports.reject("canary-worker", item.slug, "validation", "canary complete")
    ;(database as SqliteDatabase).connection.run("PRAGMA ignore_check_constraints = ON")
    ;(database as SqliteDatabase).connection.run("UPDATE skillhub_import_items SET state = 'mirrored'")
    ;(database as SqliteDatabase).connection.run("PRAGMA ignore_check_constraints = OFF")
    expect((await imports.progress()).state).toBe("completed")
    expect(generations()).toBe(1)

    let pages: number[] = []
    await discoverSkillHub({
      fetcher: async (input) => {
        pages.push(Number(new URL(String(input)).searchParams.get("page")))
        return fetcher(input)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
      limit: 100,
      refresh: true,
    })
    expect(pages).toEqual([1])
    expect(generations()).toBe(1)

    pages = []
    await discoverSkillHub({
      fetcher: async (input) => {
        pages.push(Number(new URL(String(input)).searchParams.get("page")))
        return fetcher(input)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
    })
    expect(pages).toEqual([])

    await discoverSkillHub({ fetcher, baseUrl: "https://api.skillhub.cn", imports, refresh: true })
    expect(generations()).toBe(2)
    expect(await imports.progress()).toMatchObject({ upstreamTotal: 200, pending: 100 })
    for (const item of await imports.claim("full-worker", 100, 60_000))
      await imports.reject("full-worker", item.slug, "validation", "full complete")
    expect((await imports.progress()).state).toBe("completed")
    expect(
      (database as SqliteDatabase).connection
        .query<{ state: string }, []>("SELECT state FROM skillhub_import_items WHERE slug IN ('skill-0', 'skill-99')")
        .all()
        .map((item) => item.state),
    ).toEqual(["mirrored", "mirrored"])

    pages = []
    for (let attempt = 0; attempt < 2; attempt += 1)
      await discoverSkillHub({
        fetcher: async (input) => {
          pages.push(Number(new URL(String(input)).searchParams.get("page")))
          return fetcher(input)
        },
        baseUrl: "https://api.skillhub.cn",
        imports,
        refresh: true,
      })
    expect(pages).toEqual([1, 1])
    expect(generations()).toBe(2)

    const reduced = records.slice(0, 150)
    await discoverSkillHub({
      fetcher: async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"))
        return pageResponse(reduced.slice((page - 1) * 100, page * 100), reduced.length)
      },
      baseUrl: "https://api.skillhub.cn",
      imports,
      refresh: true,
    })
    expect(generations()).toBe(3)
    expect((await imports.progress()).upstreamTotal).toBe(150)
    await database.close()
  })

  test("finishes after one moving verification sweep instead of rescanning forever", async () => {
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

    expect(result).toMatchObject({ discovered: 2, completed: true, stale: false })
    expect(await imports.activeGeneration()).toBeUndefined()
    expect(await imports.progress()).toMatchObject({ discovered: 2, sweep: 1, discoveryPage: 1 })
    await database.close()
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

function pageRecordsOf100(page: number) {
  return Array.from({ length: 100 }, (_, index) => listRecord(`page-${page}-${index}`))
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
