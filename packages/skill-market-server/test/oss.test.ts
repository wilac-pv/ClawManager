import { describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { contentAddressDetail, createCatalogIndex, type CatalogIndex, key, mergeCatalog } from "../src/catalog"
import {
  catalogIndexPayload,
  loadCatalogDetail,
  loadCurrentSnapshot,
  loadCatalogIndex,
  makeS3ObjectStore,
  publishCatalogIndex,
  publishSnapshot,
  publishSnapshotObjects,
  publishSnapshotPointer,
  type ObjectStore,
} from "../src/oss"
import { sampleDetail, sampleSnapshot } from "./fixture"

const config = { prefix: "skill-market" }

describe("OSS snapshots", () => {
  test("updates current.json only after every immutable object validates", async () => {
    const store = memoryObjectStore()
    await publishSnapshot(store.client, config, sampleSnapshot("r1"))
    expect(store.writes.at(-1)).toEqual({
      key: "skill-market/current.json",
      contentType: "application/json",
      cacheControl: "public, max-age=60",
    })

    store.failOn = /details/
    await expect(publishSnapshot(store.client, config, sampleSnapshot("r2"))).rejects.toThrow("configured failure")
    expect(JSON.parse(new TextDecoder().decode(store.objects.get("skill-market/current.json"))).revision).toBe("r1")
  })

  test("loads and validates a complete snapshot through the current pointer", async () => {
    const store = memoryObjectStore()
    await publishSnapshot(store.client, config, sampleSnapshot("r1"))
    const loaded = await loadCurrentSnapshot(store.client, config)
    expect(loaded.revision).toBe("r1")
    expect(loaded.items).toHaveLength(1)
    expect(loaded.details.get("skillhub:code-review")?.package.sha256).toBe("a".repeat(64))

    store.objects.set("skill-market/indexes/r1/catalog.json", new TextEncoder().encode("{}"))
    await expect(loadCurrentSnapshot(store.client, config)).rejects.toThrow()
  })

  test("loads a content-addressed V2 snapshot from the previous release", async () => {
    const store = memoryObjectStore()
    const snapshot = largeSnapshot()
    const references = Array.from(snapshot.details.values(), (detail) => {
      const body = new TextEncoder().encode(JSON.stringify(detail))
      const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
      store.objects.set(`skill-market/details/${sha256}.json`, body)
      return {
        summary: snapshot.items.find((item) => item.id === detail.id)!,
        detail: { key: `details/${sha256}.json`, sha256 },
      }
    })
    store.objects.set(
      "skill-market/current.json",
      new TextEncoder().encode(JSON.stringify({ revision: snapshot.revision, createdAt: snapshot.createdAt })),
    )
    store.objects.set(
      "skill-market/indexes/legacy/catalog.json",
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 2,
          revision: snapshot.revision,
          createdAt: snapshot.createdAt,
          items: references,
        }),
      ),
    )
    store.objects.set(
      "skill-market/indexes/legacy/facets.json",
      new TextEncoder().encode(JSON.stringify(snapshot.facets)),
    )
    store.getDelay = 1

    const loaded = await loadCurrentSnapshot(store.client, config)

    expect(loaded.items).toHaveLength(33)
    expect(store.maximumGets).toBeLessThanOrEqual(32)
  })

  test("bounds immutable snapshot publication concurrency", async () => {
    const store = memoryObjectStore()
    store.putDelay = 1

    await publishSnapshotObjects(store.client, config, largeSnapshot())

    expect(store.maximumPuts).toBeLessThanOrEqual(32)
    expect(store.maximumGets).toBeLessThanOrEqual(32)
  })

  test("writes immutable snapshot objects before moving the current pointer", async () => {
    const store = memoryObjectStore()
    const snapshot = sampleSnapshot("r1")

    await publishSnapshotObjects(store.client, config, snapshot)
    expect(store.objects.has("skill-market/current.json")).toBe(false)
    await publishSnapshotPointer(store.client, config, snapshot)
    expect(JSON.parse(new TextDecoder().decode(store.objects.get("skill-market/current.json"))).revision).toBe("r1")
  })

  test("streams a byte-identical v2 catalog payload with an exact content length", async () => {
    const snapshot = sampleSnapshot("stream-v2")
    const index = createCatalogIndex({
      entries: new Map(Array.from(snapshot.details, ([entryKey, detail]) => [entryKey, contentAddressDetail(detail)])),
      sourceStatus: snapshot.sourceStatus,
      createdAt: snapshot.createdAt,
    })
    const expected = JSON.stringify({
      schemaVersion: 2,
      revision: index.revision,
      createdAt: index.createdAt,
      items: index.items.map((summary) => ({ summary, detail: index.details.get(key(summary.source, summary.id)) })),
    })
    const payload = catalogIndexPayload(index)
    const chunks: Uint8Array[] = []
    for await (const chunk of payload.body()) chunks.push(chunk)
    const body = await new Blob(chunks).text()

    expect(body).toBe(expected)
    expect(payload.contentLength).toBe(new TextEncoder().encode(expected).byteLength)
  })

  test("publishes one changed detail for an 80,000-item v2 index before the index and pointer", async () => {
    const store = memoryObjectStore()
    const snapshot = sampleSnapshot("v2")
    const detail = snapshot.details.get("skillhub:code-review")!
    const changed = { ...detail, id: "skill-0" }
    const body = JSON.stringify(changed)
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex")
    const items = Array.from({ length: 80_000 }, (_, index) => ({ ...snapshot.items[0]!, id: `skill-${index}` }))
    const index: CatalogIndex = {
      revision: "v2",
      createdAt: snapshot.createdAt,
      items,
      details: new Map(
        items.map((item) => [
          key(item.source, item.id),
          {
            key: `details/${item.id === "skill-0" ? hash : "b".repeat(64)}.json`,
            sha256: item.id === "skill-0" ? hash : "b".repeat(64),
            version: item.version,
          },
        ] as const),
      ),
      facets: { ...snapshot.facets, revision: "v2" },
      sourceStatus: snapshot.sourceStatus,
    }

    await publishCatalogIndex(store.client, config, index, new Map([["skillhub:skill-0", changed]]))
    expect(store.writes.map((write) => write.key)).toEqual([
      `skill-market/details/${hash}.json`,
      "skill-market/indexes/v2/catalog.json",
      "skill-market/indexes/v2/facets.json",
      "skill-market/current.json",
    ])
    const loaded = await loadCatalogIndex(store.client, config)
    expect(loaded.items).toHaveLength(80_000)
    expect(loaded.details.get("skillhub:skill-0")).toEqual({
      key: `details/${hash}.json`,
      sha256: hash,
      version: changed.version,
    })
  })

  test("reuses global v2 details across revisions while publishing only the changed object", async () => {
    const store = memoryObjectStore()
    const unchanged = sampleSnapshot("seed").details.get("skillhub:code-review")!
    const changed = { ...unchanged, id: "changed" }
    const r1 = catalogIndex("r1", [unchanged, changed])
    await publishCatalogIndex(
      store.client,
      config,
      r1,
      new Map([
        ["skillhub:code-review", unchanged],
        ["skillhub:changed", changed],
      ]),
    )

    const revised = { ...changed, version: "2.0.0" }
    const r2 = catalogIndex("r2", [unchanged, revised])
    store.writes.splice(0)
    await publishCatalogIndex(store.client, config, r2, new Map([["skillhub:changed", revised]]))

    const changedHash = sha256(JSON.stringify(revised))
    expect(store.writes.map((write) => write.key)).toEqual([
      `skill-market/details/${changedHash}.json`,
      "skill-market/indexes/r2/catalog.json",
      "skill-market/indexes/r2/facets.json",
      "skill-market/current.json",
    ])
    const loaded = await loadCatalogIndex(store.client, config)
    expect((await loadCatalogDetail(store.client, config, loaded, "skillhub", "code-review"))?.id).toBe("code-review")
    expect((await loadCatalogDetail(store.client, config, loaded, "skillhub", "changed"))?.version).toBe("2.0.0")
  })

  test("streams private objects without SDK aws-chunked checksum headers", async () => {
    const bodies: Uint8Array[] = []
    const requestHeaders: Headers[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestHeaders.push(request.headers)
        bodies.push(new Uint8Array(await request.arrayBuffer()))
        return new Response(null, { status: 200, headers: { etag: '"test"' } })
      },
    })
    const accessKeyID = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    process.env.AWS_ACCESS_KEY_ID = "test-access-key"
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key"

    try {
      const store = makeS3ObjectStore({
        endpoint: `http://127.0.0.1:${server.port}`,
        region: "test-region",
        bucket: "test-bucket",
      })
      await store.putPrivate("private/canary", chunks("hello", " world"), "application/octet-stream", undefined)
      expect(new TextDecoder().decode(bodies[0])).toBe("hello world")
      expect(requestHeaders[0].has("if-none-match")).toBe(false)
    } finally {
      server.stop(true)
      if (accessKeyID === undefined) delete process.env.AWS_ACCESS_KEY_ID
      else process.env.AWS_ACCESS_KEY_ID = accessKeyID
      if (secretAccessKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY
      else process.env.AWS_SECRET_ACCESS_KEY = secretAccessKey
    }
  })
})

async function* chunks(...values: string[]) {
  for (const value of values) yield new TextEncoder().encode(value)
}

function memoryObjectStore() {
  const objects = new Map<string, Uint8Array>()
  const writes: Array<{ key: string; contentType: string; cacheControl: string }> = []
  const state: {
    failOn?: RegExp
    getDelay?: number
    putDelay?: number
    activeGets: number
    maximumGets: number
    activePuts: number
    maximumPuts: number
  } = {
    activeGets: 0,
    maximumGets: 0,
    activePuts: 0,
    maximumPuts: 0,
  }
  const client: ObjectStore = {
    async put(key, body, contentType, cacheControl) {
      if (state.failOn?.test(key)) throw new Error(`configured failure for ${key}`)
      state.activePuts += 1
      state.maximumPuts = Math.max(state.maximumPuts, state.activePuts)
      if (state.putDelay) await Bun.sleep(state.putDelay)
      state.activePuts -= 1
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
      writes.push({ key, contentType, cacheControl })
    },
    async putStream(key, body, contentLength, contentType, cacheControl) {
      if (state.failOn?.test(key)) throw new Error(`configured failure for ${key}`)
      const chunks = await Array.fromAsync(body)
      const output = new Uint8Array(contentLength)
      const written = chunks.reduce((offset, chunk) => {
        output.set(chunk, offset)
        return offset + chunk.byteLength
      }, 0)
      if (written !== contentLength) throw new Error(`stream length mismatch for ${key}`)
      objects.set(key, output)
      writes.push({ key, contentType, cacheControl })
    },
    async get(key) {
      const value = objects.get(key)
      if (!value) throw new Error(`missing object ${key}`)
      state.activeGets += 1
      state.maximumGets = Math.max(state.maximumGets, state.activeGets)
      if (state.getDelay) await Bun.sleep(state.getDelay)
      state.activeGets -= 1
      return value
    },
    async head(key) {
      const value = objects.get(key)
      if (!value) throw new Error(`missing object ${key}`)
      return { size: value.byteLength }
    },
  }
  return {
    objects,
    writes,
    client,
    get failOn() {
      return state.failOn
    },
    set failOn(value: RegExp | undefined) {
      state.failOn = value
    },
    get maximumGets() {
      return state.maximumGets
    },
    set getDelay(value: number | undefined) {
      state.getDelay = value
    },
    get maximumPuts() {
      return state.maximumPuts
    },
    set putDelay(value: number | undefined) {
      state.putDelay = value
    },
  }
}

function largeSnapshot() {
  const merged = mergeCatalog(
    Array.from({ length: 33 }, (_, index) =>
      sampleDetail({
        id: `skill-${index}`,
        name: `Skill ${index}`,
        publicDetailUrl: `https://skillhub.cn/skills/${index}`,
      }),
    ),
    Schema.decodeUnknownSync(SkillMarket.EnterpriseIndex)({
      schemaVersion: 1,
      updatedAt: "2026-07-15T00:00:00.000Z",
      skills: [],
    }),
  )
  return {
    ...merged,
    revision: "legacy",
    createdAt: "2026-07-15T00:00:00.000Z",
    facets: { ...merged.facets, revision: "legacy" },
  }
}

function catalogIndex(revision: string, details: ReadonlyArray<SkillMarket.Detail>): CatalogIndex {
  const snapshot = sampleSnapshot(revision)
  return {
    revision,
    createdAt: snapshot.createdAt,
    items: details.map(summary),
    details: new Map(
      details.map(
        (detail) =>
          [
            key(detail.source, detail.id),
            {
              key: `details/${sha256(JSON.stringify(detail))}.json`,
              sha256: sha256(JSON.stringify(detail)),
              version: detail.version,
            },
          ] as const,
      ),
    ),
    facets: { ...snapshot.facets, revision },
    sourceStatus: snapshot.sourceStatus,
  }
}

function summary(detail: SkillMarket.Detail) {
  const { readme: _readme, author: _author, versions: _versions, securityReports: _securityReports, package: _package, ...value } = detail
  return value
}

function sha256(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}
