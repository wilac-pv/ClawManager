import { describe, expect, test } from "bun:test"
import {
  loadCurrentSnapshot,
  loadCatalogIndex,
  makeS3ObjectStore,
  publishCatalogIndex,
  publishSnapshot,
  publishSnapshotObjects,
  publishSnapshotPointer,
  type ObjectStore,
} from "../src/oss"
import { sampleSnapshot } from "./fixture"
import { type CatalogIndex, key } from "../src/catalog"

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

  test("writes immutable snapshot objects before moving the current pointer", async () => {
    const store = memoryObjectStore()
    const snapshot = sampleSnapshot("r1")

    await publishSnapshotObjects(store.client, config, snapshot)
    expect(store.objects.has("skill-market/current.json")).toBe(false)
    await publishSnapshotPointer(store.client, config, snapshot)
    expect(JSON.parse(new TextDecoder().decode(store.objects.get("skill-market/current.json"))).revision).toBe("r1")
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
          { key: `details/${item.id === "skill-0" ? hash : "b".repeat(64)}.json`, sha256: item.id === "skill-0" ? hash : "b".repeat(64) },
        ] as const),
      ),
      facets: { ...snapshot.facets, revision: "v2" },
      sourceStatus: snapshot.sourceStatus,
    }

    await publishCatalogIndex(store.client, config, index, new Map([["skillhub:skill-0", changed]]))
    expect(store.writes.map((write) => write.key)).toEqual([
      `skill-market/indexes/v2/details/${hash}.json`,
      "skill-market/indexes/v2/catalog.json",
      "skill-market/indexes/v2/facets.json",
      "skill-market/current.json",
    ])
    const loaded = await loadCatalogIndex(store.client, config)
    expect(loaded.items).toHaveLength(80_000)
    expect(loaded.details.get("skillhub:skill-0")).toEqual({ key: `details/${hash}.json`, sha256: hash })
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
  const state: { failOn?: RegExp } = {}
  const client: ObjectStore = {
    async put(key, body, contentType, cacheControl) {
      if (state.failOn?.test(key)) throw new Error(`configured failure for ${key}`)
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
      writes.push({ key, contentType, cacheControl })
    },
    async get(key) {
      const value = objects.get(key)
      if (!value) throw new Error(`missing object ${key}`)
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
  }
}
