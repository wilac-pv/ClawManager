import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import type { PrivateObjectStore } from "../src/oss"
import { createSkillHubImportStore } from "../src/skillhub-import-store"
import { createSkillHubMirror } from "../src/skillhub-mirror"
import { normalizeSkillHubArchive } from "../src/skillhub-archive"
import type { SkillHubListRecord, SkillHubRecord } from "../src/skillhub"
import { makeZip } from "./zip"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("SkillHub mirror", () => {
  test("handles one bounded claim per batch and retains publicly addressable object keys", async () => {
    const fixture = await databaseFixture()
    const imports = createSkillHubImportStore({ database: fixture.database })
    const generation = imports.beginGeneration(3)
    imports.recordPage(generation.id, 1, [list("one"), list("two"), list("three")])
    const objects = memoryStore()
    const mirror = createSkillHubMirror({
      imports,
      store: objects,
      allowedHosts: new Set(["packages.example.com"]),
      objectPrefix: "public-catalog",
      publicBaseUrl: "https://market.example.com/public-catalog/",
      loadRecord: async (item) => record(item.slug),
      fetcher: async (input) => new Response(packageZip(new URL(requestUrl(input)).searchParams.get("slug")!)),
      packageConcurrency: 2,
    })

    expect(await mirror.runBatch("mirror-a")).toEqual({ mirrored: 2, retryWait: 0, rejected: 0 })
    expect(imports.progress()).toMatchObject({ mirrored: 2, pending: 1 })
    const detail = JSON.parse(new TextDecoder().decode(await objects.get(objects.keys().find((key) => key.includes("/details/"))!)))
    expect(detail.package.url).toContain("/public-catalog/packages/")
    expect(objects.keys()).toContain(`public-catalog/packages/${detail.package.sha256}.zip`)
    fixture.database.close()
  })

  test("overwrites same-size corrupt content-addressed objects with verified immutable objects", async () => {
    const fixture = await databaseFixture()
    const imports = createSkillHubImportStore({ database: fixture.database })
    const generation = imports.beginGeneration(1)
    imports.recordPage(generation.id, 1, [list("corrupt")])
    const body = packageZip("corrupt")
    const normalized = normalizeSkillHubArchive(body, record("corrupt")).body
    const packageSha256 = new Bun.CryptoHasher("sha256").update(normalized).digest("hex")
    const objects = memoryStore({
      initial: new Map([[`public-catalog/packages/${packageSha256}.zip`, new Uint8Array(normalized.byteLength).fill(7)]]),
    })
    const mirror = createSkillHubMirror({
      imports,
      store: objects,
      allowedHosts: new Set(["packages.example.com"]),
      objectPrefix: "public-catalog",
      publicBaseUrl: "https://market.example.com/public-catalog/",
      loadRecord: async (item) => record(item.slug),
      fetcher: async () => new Response(body),
    })

    expect(await mirror.runBatch("mirror-a")).toEqual({ mirrored: 1, retryWait: 0, rejected: 0 })
    expect(await objects.get(`public-catalog/packages/${packageSha256}.zip`)).not.toEqual(new Uint8Array(normalized.byteLength).fill(7))
    expect(objects.cacheControls()).toContain("public, max-age=31536000, immutable")
    fixture.database.close()
  })

  test("content-addresses normalized packages, retries 429s, and rejects malware and traversal archives", async () => {
    const fixture = await databaseFixture()
    const imports = createSkillHubImportStore({ database: fixture.database })
    const generation = imports.beginGeneration(6)
    const slugs = ["duplicate-a", "duplicate-b", "throttled", "malware", "traversal", "normal"]
    imports.recordPage(generation.id, 1, slugs.map((slug) => list(slug)))
    const objects = memoryStore()
    let throttled = false
    const mirror = createSkillHubMirror({
      imports,
      store: objects,
      allowedHosts: new Set(["packages.example.com"]),
      publicBaseUrl: "https://market.example.com/private/",
      loadRecord: async (item) => record(item.slug === "duplicate-b" ? "duplicate-a" : item.slug, item.slug === "malware"),
      fetcher: async (input) => {
        const slug = new URL(requestUrl(input)).searchParams.get("slug")
        if (slug === "throttled" && !throttled) {
          throttled = true
          return new Response("slow down", { headers: { "retry-after": "0" }, status: 429 })
        }
        return new Response(
          slug === "traversal"
            ? traversalZip()
            : slug === "normal"
              ? packageZip("normal")
              : packageZip("duplicate"),
        )
      },
      packageConcurrency: 6,
      wait: async () => undefined,
    })

    const result = await mirror.runBatch("mirror-a")

    expect(result).toEqual({ mirrored: 4, retryWait: 0, rejected: 2 })
    expect(objects.keys().filter((key) => key.includes("/packages/")).length).toBe(3)
    expect(imports.progress().packageConcurrency).toBeLessThanOrEqual(6)
    expect(state(fixture.database, "malware")).toBe("rejected")
    expect(state(fixture.database, "traversal")).toBe("rejected")

    const puts = objects.puts()
    expect(await mirror.runBatch("mirror-restarted")).toEqual({ mirrored: 0, retryWait: 0, rejected: 0 })
    expect(objects.puts()).toBe(puts)
    fixture.database.close()
  })

  test("leaves transient OSS failures retryable and stops claiming after the memory soft limit", async () => {
    const fixture = await databaseFixture()
    const clock = { value: 1_752_537_600_000 }
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => clock.value })
    const generation = imports.beginGeneration(1)
    imports.recordPage(generation.id, 1, [list("oss-retry")])
    const objects = memoryStore({ failPut: true })
    const retry = createSkillHubMirror({
      imports,
      store: objects,
      allowedHosts: new Set(["packages.example.com"]),
      publicBaseUrl: "https://market.example.com/private/",
      loadRecord: async (item) => record(item.slug),
      fetcher: async () => new Response(packageZip("oss-retry")),
      packageConcurrency: 1,
      now: () => clock.value,
      random: () => 0,
      wait: async () => undefined,
    })

    expect(await retry.runBatch("mirror-a")).toEqual({ mirrored: 0, retryWait: 1, rejected: 0 })
    expect(state(fixture.database, "oss-retry")).toBe("retry_wait")
    clock.value += 2_000
    const recovered = createSkillHubMirror({
      imports,
      store: memoryStore(),
      allowedHosts: new Set(["packages.example.com"]),
      publicBaseUrl: "https://market.example.com/private/",
      loadRecord: async (item) => record(item.slug),
      fetcher: async () => new Response(packageZip("oss-retry")),
      packageConcurrency: 1,
      now: () => clock.value,
      random: () => 0,
    })
    expect(await recovered.runBatch("mirror-b")).toEqual({ mirrored: 1, retryWait: 0, rejected: 0 })
    fixture.database.close()

    const memoryFixture = await databaseFixture()
    const memoryImports = createSkillHubImportStore({ database: memoryFixture.database })
    const memoryGeneration = memoryImports.beginGeneration(3)
    memoryImports.recordPage(memoryGeneration.id, 1, [list("memory-a"), list("memory-b"), list("memory-c")])
    const memory = createSkillHubMirror({
      imports: memoryImports,
      store: memoryStore(),
      allowedHosts: new Set(["packages.example.com"]),
      publicBaseUrl: "https://market.example.com/private/",
      loadRecord: async (item) => record(item.slug),
      fetcher: async (input) => new Response(packageZip(new URL(requestUrl(input)).searchParams.get("slug")!)),
      packageConcurrency: 2,
      memorySoftLimitMb: 512,
      rssBytes: (() => {
        let reads = 0
        return () => (reads++ === 0 ? 0 : 513 * 1024 * 1024)
      })(),
    })

    expect(await memory.runBatch("mirror-b")).toEqual({ mirrored: 2, retryWait: 0, rejected: 0 })
    expect(memoryImports.progress()).toMatchObject({ mirrored: 2, pending: 1 })
    memoryFixture.database.close()
  })
})

function list(slug: string): SkillHubListRecord {
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
    updated_at: 1_752_537_600_000,
    version: "1.0.0",
  }
}

function record(slug: string, malicious = false): SkillHubRecord {
  return {
    slug,
    name: slug,
    description: `${slug} description`,
    categories: ["tools"],
    tags: ["test"],
    requiresApiKey: false,
    risk: malicious ? "danger" : "safe",
    version: "1.0.0",
    updatedAt: "2026-07-17T00:00:00.000Z",
    downloads: 1,
    favorites: 1,
    score: 1,
    sourceUrl: "https://skillhub.cn/skills/test",
    publicDetailUrl: "https://skillhub.cn/skills/test",
    author: { name: "SkillHub" },
    files: [],
    versions: [{ version: "1.0.0", publishedAt: "2026-07-17T00:00:00.000Z", changelog: "Initial" }],
    securityReports: malicious ? [{ provider: "scanner", verdict: "danger", summary: "malware" }] : [],
    downloadUrl: `https://packages.example.com/download?slug=${encodeURIComponent(slug)}`,
  }
}

function packageZip(name: string) {
  return makeZip([{ name: "SKILL.md", content: `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}` }])
}

function traversalZip() {
  return makeZip([
    { name: "SKILL.md", content: "---\nname: safe\ndescription: safe\n---\n# Safe" },
    { name: "../escape", content: "bad" },
  ])
}

function memoryStore(options: { readonly failPut?: boolean; readonly initial?: Map<string, Uint8Array> } = {}) {
  const objects = new Map(options.initial)
  let count = 0
  const cacheControls: string[] = []
  const store: PrivateObjectStore = {
    async put(key, body, _contentType, cacheControl) {
      count += 1
      if (options.failPut) throw new Error("temporary OSS outage")
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
      cacheControls.push(cacheControl)
    },
    async get(key) {
      const body = objects.get(key)
      if (!body) throw new Error(`missing ${key}`)
      return body
    },
    async head(key) {
      const body = objects.get(key)
      if (!body) throw new Error(`missing ${key}`)
      return { size: body.byteLength }
    },
    async putPrivate() {},
    async copy() {},
    async delete() {},
  }
  return Object.assign(store, { keys: () => [...objects.keys()], puts: () => count, cacheControls: () => cacheControls })
}

function state(database: Awaited<ReturnType<typeof openDatabase>>, slug: string) {
  return database.connection.query<{ state: string }, [string]>("SELECT state FROM skillhub_import_items WHERE slug = ?").get(slug)?.state
}

async function databaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-mirror-"))
  directories.push(directory)
  return {
    database: await openDatabase({ databasePath: join(directory, "market.db"), migrationBackupDirectory: join(directory, "backups") }),
  }
}

function requestUrl(input: string | URL | Request) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}
