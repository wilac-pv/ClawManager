import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config"
import { openDatabase } from "../src/database"
import type { PrivateObjectStore } from "../src/oss"
import { publishSnapshot } from "../src/oss"
import { createPublisher } from "../src/publisher"
import { materializeSkillHubRecord, materializeSkillHubRecords, synchronize, verifySkillArchive } from "../src/sync"
import type { SkillHubRecord } from "../src/skillhub"
import { sampleDetail, sampleSnapshot } from "./fixture"
import { makeStoredZip } from "./zip"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("catalog synchronization", () => {
  test("follows approved redirects and materializes a verified SkillHub package", async () => {
    const skill = "---\nname: verified-review\ndescription: Verified review\nlicense: MIT\n---\n# Verified Review\n"
    const guide = "Review carefully."
    const archive = makeStoredZip({
      "SKILL.md": skill,
      "references/guide.md": guide,
      "_meta.json": JSON.stringify({ ownerId: "1", slug: "code-review", version: "1.0.0", publishedAt: 1 }),
    })
    const writes = new Map<string, Uint8Array>()
    const detail = await materializeSkillHubRecord(sampleRecord(skill, guide), {
      fetcher: async (input) => {
        if (requestUrl(input).includes("api.skillhub.cn"))
          return new Response(null, {
            status: 302,
            headers: { location: "https://packages.example.com/code-review.zip" },
          })
        return new Response(archive, {
          headers: { "content-length": String(archive.byteLength), "content-type": "application/zip" },
        })
      },
      store: memoryStore(writes),
      allowedHosts: new Set(["api.skillhub.cn", "packages.example.com"]),
      ossPrefix: "skill-market",
      publicBaseUrl: "https://oss.example.com/skill-market/",
    })
    expect(detail.id).toBe("verified-review")
    expect(detail.readme.trim()).toBe("# Verified Review")
    expect(detail.license).toBe("MIT")
    expect(detail.aliases).toContain("code-review")
    expect(detail.package.files).toHaveLength(3)
    expect(writes.has(`skill-market/packages/${detail.package.sha256}.zip`)).toBe(true)
  })

  test("rejects traversal entries and manifest mismatches", async () => {
    expect(() => verifySkillArchive(makeStoredZip({ "../escape": "bad", "SKILL.md": "# bad" }))).toThrow(
      "unsafe ZIP path",
    )
    const archive = makeStoredZip({ "SKILL.md": "---\nname: safe\ndescription: Safe\n---\n# Safe" })
    await expect(
      materializeSkillHubRecord(sampleRecord("different", "missing"), {
        fetcher: async () => new Response(archive),
        store: memoryStore(new Map()),
        allowedHosts: new Set(["api.skillhub.cn"]),
        ossPrefix: "skill-market",
        publicBaseUrl: "https://oss.example.com/skill-market/",
      }),
    ).rejects.toThrow("file manifest")

    await expect(
      materializeSkillHubRecord(sampleRecord("different", "missing"), {
        fetcher: async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example.com/package.zip" } }),
        store: memoryStore(new Map()),
        allowedHosts: new Set(["api.skillhub.cn"]),
        ossPrefix: "skill-market",
        publicBaseUrl: "https://oss.example.com/skill-market/",
      }),
    ).rejects.toThrow("not allowed")
  })

  test("isolates invalid SkillHub packages and retains their prior verified detail", async () => {
    const skill = "---\nname: verified-review\ndescription: Verified review\n---\n# Verified Review\n"
    const guide = "Review carefully."
    const archive = makeStoredZip({ "SKILL.md": skill, "references/guide.md": guide })
    const valid = sampleRecord(skill, guide)
    const invalid = { ...valid, slug: "invalid", downloadUrl: "https://api.skillhub.cn/api/v1/download?slug=invalid" }
    const previous = sampleDetail({ id: "invalid", name: "Previously verified" })
    const details = await materializeSkillHubRecords(
      [valid, invalid],
      {
        fetcher: async (input) =>
          requestUrl(input).includes("slug=invalid") ? new Response(null, { status: 500 }) : new Response(archive),
        store: memoryStore(new Map()),
        allowedHosts: new Set(["api.skillhub.cn"]),
        ossPrefix: "skill-market",
        publicBaseUrl: "https://oss.example.com/skill-market/",
      },
      new Map([["invalid", previous]]),
    )
    expect(details.map((detail) => detail.id)).toEqual(["verified-review", "invalid"])
  })

  test("rejects a local filename that differs from its central directory entry", () => {
    const archive = makeStoredZip({
      "safe.md": "x",
      "SKILL.md": "---\nname: safe\ndescription: Safe\n---\n# Safe",
    })
    archive.set(new TextEncoder().encode("../x.md"), 30)
    expect(() => verifySkillArchive(archive)).toThrow("ZIP local filename mismatch")
  })

  test("falls back to the prior enterprise overlay when fresh package materialization fails", async () => {
    const objects = new Map<string, Uint8Array>()
    const store = memoryStore(objects)
    const previous = sampleSnapshot("prior")
    previous.items[0] = { ...previous.items[0], name: "企业 Code Review", enterprise: true, featured: true }
    previous.details.set(
      "skillhub:code-review",
      sampleDetail({ name: "企业 Code Review", enterprise: true, featured: true }),
    )
    await publishSnapshot(store, { prefix: "skill-market" }, previous)
    await store.put(
      "skill-market/sync-state.json",
      JSON.stringify({ lastSkillhubAt: "2026-07-15T00:00:00.000Z" }),
      "application/json",
      "no-store",
    )
    const config = loadConfig({
      SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
      SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
      SKILL_MARKET_PUBLIC_BASE_URL: "https://oss.example.com/skill-market/",
      SKILL_MARKET_OSS_PREFIX: "skill-market",
      SKILL_MARKET_ALLOWED_HOSTS: "api.skillhub.cn,oss.example.com,packages.example.com",
    })
    const result = await synchronize({
      config,
      store,
      now: () => new Date("2026-07-15T00:05:00.000Z"),
      fetcher: async (input) => {
        if (requestUrl(input).includes("enterprise.json"))
          return Response.json({
            schemaVersion: 1,
            updatedAt: "2026-07-15T00:05:00.000Z",
            skills: [
              {
                id: "new-enterprise-skill",
                source: "enterprise",
                featured: true,
                name: "New Enterprise Skill",
                description: "New",
                category: "Enterprise",
                version: "1.0.0",
                package: { url: "https://packages.example.com/new.zip", sha256: "c".repeat(64) },
              },
            ],
          })
        return new Response(null, { status: 500 })
      },
    })
    expect(result.published).toBe(true)
    expect(result.snapshot.sourceStatus.enterprise).toBe("stale")
    expect(result.snapshot.items[0]?.name).toBe("企业 Code Review")
  })

  test("reuses a cached enterprise index on ETag 304", async () => {
    const objects = new Map<string, Uint8Array>()
    const store = memoryStore(objects)
    await publishSnapshot(store, { prefix: "skill-market" }, sampleSnapshot("prior"))
    await store.put(
      "skill-market/sync-state.json",
      JSON.stringify({
        lastSkillhubAt: "2026-07-15T00:00:00.000Z",
        enterpriseEtag: '"e1"',
        enterpriseIndex: { schemaVersion: 1, updatedAt: "2026-07-15T00:00:00.000Z", skills: [] },
      }),
      "application/json",
      "no-store",
    )
    let conditional = false
    const result = await synchronize({
      config: loadConfig({
        SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
        SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
        SKILL_MARKET_PUBLIC_BASE_URL: "https://oss.example.com/skill-market/",
        SKILL_MARKET_OSS_PREFIX: "skill-market",
        SKILL_MARKET_ALLOWED_HOSTS: "api.skillhub.cn,oss.example.com",
      }),
      store,
      now: () => new Date("2026-07-15T00:05:00.000Z"),
      fetcher: async (_input, init) => {
        conditional = new Headers(init?.headers).get("if-none-match") === '"e1"'
        return new Response(null, { status: 304 })
      },
    })
    expect(conditional).toBe(true)
    expect(result.snapshot.sourceStatus.enterprise).toBe("fresh")
  })

  test("marks the community source fresh when the control database is available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-sync-community-"))
    directories.push(directory)
    const database = await openDatabase({
      databasePath: join(directory, "market.db"),
      migrationBackupDirectory: join(directory, "backups"),
    })
    const objects = new Map<string, Uint8Array>()
    const store = memoryStore(objects)
    await publishSnapshot(store, { prefix: "skill-market" }, sampleSnapshot("prior"))
    database.transaction((connection) =>
      connection.run(
        `INSERT INTO publish_jobs (id, kind, status, attempts, created_at, updated_at)
         VALUES ('job_rebuild_before_sync', 'catalog_rebuild', 'pending', 0, ?, ?)`,
        [Date.parse("2026-07-15T00:04:00.000Z"), Date.parse("2026-07-15T00:04:00.000Z")],
      ),
    )
    await store.put(
      "skill-market/sync-state.json",
      JSON.stringify({
        lastSkillhubAt: "2026-07-15T00:00:00.000Z",
        enterpriseEtag: '"e1"',
        enterpriseIndex: { schemaVersion: 1, updatedAt: "2026-07-15T00:00:00.000Z", skills: [] },
      }),
      "application/json",
      "no-store",
    )
    const result = await synchronize({
      config: loadConfig({
        SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
        SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
        SKILL_MARKET_PUBLIC_BASE_URL: "https://oss.example.com/skill-market/",
        SKILL_MARKET_OSS_PREFIX: "skill-market",
        SKILL_MARKET_ALLOWED_HOSTS: "api.skillhub.cn,oss.example.com",
      }),
      database,
      publisher: createPublisher({
        database,
        store,
        ossPrefix: "skill-market",
        publicBaseUrl: "https://oss.example.com/skill-market/",
        webBaseUrl: "https://market.example.com/",
        now: () => Date.parse("2026-07-15T00:05:00.000Z"),
      }),
      store,
      now: () => new Date("2026-07-15T00:05:00.000Z"),
      fetcher: async () => new Response(null, { status: 304 }),
    })

    expect(result.snapshot.sourceStatus.community).toBe("fresh")
    expect(
      database.connection
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM publish_jobs WHERE status IN ('pending', 'running')")
        .get()?.count,
    ).toBe(0)
    database.close()
  })
})

function sampleRecord(skill: string, guide: string): SkillHubRecord {
  return {
    slug: "code-review",
    name: "Code Review",
    description: "Review code",
    categories: ["Development"],
    tags: ["review"],
    requiresApiKey: false,
    risk: "safe",
    version: "1.0.0",
    updatedAt: "2026-07-15T00:00:00.000Z",
    downloads: 20,
    favorites: 3,
    score: 9.5,
    sourceUrl: "https://skillhub.cn/skills/code-review",
    publicDetailUrl: "https://skillhub.cn/skills/code-review",
    author: { name: "wpank" },
    files: [
      { path: "SKILL.md", sha256: sha256(skill), size: new TextEncoder().encode(skill).byteLength },
      { path: "references/guide.md", sha256: sha256(guide), size: new TextEncoder().encode(guide).byteLength },
    ],
    versions: [{ version: "1.0.0", publishedAt: "2026-07-15T00:00:00.000Z", changelog: "Initial" }],
    securityReports: [],
    downloadUrl: "https://api.skillhub.cn/api/v1/download?slug=code-review&version=1.0.0",
  }
}

function sha256(input: string) {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex")
}

function memoryStore(objects: Map<string, Uint8Array>): PrivateObjectStore {
  return {
    async put(key, body) {
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
      return { size: body.byteLength }
    },
    async putPrivate(key, body) {
      const chunks = await Array.fromAsync(body)
      const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
      chunks.reduce((offset, chunk) => {
        output.set(chunk, offset)
        return offset + chunk.byteLength
      }, 0)
      objects.set(key, output)
    },
    async copy(source, target) {
      const body = objects.get(source)
      if (!body) throw new Error(`missing ${source}`)
      objects.set(target, body.slice())
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

function requestUrl(input: string | URL | Request) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}
