import { expect, test } from "bun:test"
import { createCatalogReader } from "../src/catalog-reader"
import { type CatalogIndex, key } from "../src/catalog"
import { publishCatalogIndex, type ObjectStore } from "../src/oss"
import { sampleDetail, sampleSnapshot } from "./fixture"

const config = { prefix: "skill-market" }

test("reads an 80,000-item v2 list without fetching details and caches one requested detail", async () => {
  const store = memoryObjectStore()
  const details = Array.from({ length: 80_000 }, (_, index) => {
    const detail = sampleDetail({ id: `skill-${index}`, name: `Skill ${index}`, score: 80_000 - index })
    return [key(detail.source, detail.id), detail] as const
  })
  const index = catalogIndex("large", details)
  await publishCatalogIndex(store.client, config, index, new Map(details))
  store.resetReads()

  const reader = createCatalogReader({ store: store.client, prefix: config.prefix, ttlMilliseconds: 60_000 })
  expect((await reader.list({ page: 1, limit: 30, sort: "trending" })).items).toHaveLength(30)
  expect(store.reads.detail).toBe(0)
  expect((await reader.detail("skillhub", "skill-79999"))?.id).toBe("skill-79999")
  expect(store.reads.detail).toBe(1)
  await reader.detail("skillhub", "skill-79999")
  expect(store.reads.detail).toBe(1)
  expect(store.reads.pointer).toBe(1)
  expect(store.reads.index).toBe(1)
  expect(store.reads.facets).toBe(1)
}, 30_000)

test("evicts the least recently used decoded detail after 512 entries", async () => {
  const store = memoryObjectStore()
  const details = Array.from({ length: 513 }, (_, index) => {
    const detail = sampleDetail({ id: `skill-${index}` })
    return [key(detail.source, detail.id), detail] as const
  })
  await publishCatalogIndex(store.client, config, catalogIndex("lru", details), new Map(details))
  store.resetReads()
  const reader = createCatalogReader({ store: store.client, prefix: config.prefix })
  for (const [, detail] of details) await reader.detail(detail.source, detail.id)
  expect(store.reads.detail).toBe(513)
  await reader.detail("skillhub", "skill-0")
  expect(store.reads.detail).toBe(514)
})

test("coalesces concurrent detail reads and clears a rejected request for retry", async () => {
  const store = memoryObjectStore()
  const detail = sampleDetail()
  await publishCatalogIndex(store.client, config, catalogIndex("concurrent", [[key(detail.source, detail.id), detail]]), new Map([[key(detail.source, detail.id), detail]]))
  store.resetReads()
  const reader = createCatalogReader({ store: store.client, prefix: config.prefix })
  const values = await Promise.all(Array.from({ length: 100 }, () => reader.detail(detail.source, detail.id)))
  expect(values.every((value) => value?.id === detail.id)).toBe(true)
  expect(store.reads.detail).toBe(1)
  expect(store.reads.detailHead).toBe(1)

  const retryStore = memoryObjectStore()
  await publishCatalogIndex(retryStore.client, config, catalogIndex("retry", [[key(detail.source, detail.id), detail]]), new Map([[key(detail.source, detail.id), detail]]))
  retryStore.resetReads()
  retryStore.failDetailGets = 1
  const retryReader = createCatalogReader({ store: retryStore.client, prefix: config.prefix })
  await expect(Promise.all(Array.from({ length: 100 }, () => retryReader.detail(detail.source, detail.id)))).rejects.toThrow("configured detail failure")
  expect((await retryReader.detail(detail.source, detail.id))?.id).toBe(detail.id)
  expect(retryStore.reads.detail).toBe(2)
})

test("rejects a v2 detail whose body does not match its index hash before schema decoding", async () => {
  const store = memoryObjectStore()
  const detail = sampleDetail()
  await publishCatalogIndex(store.client, config, catalogIndex("hash", [[key(detail.source, detail.id), detail]]), new Map([[key(detail.source, detail.id), detail]]))
  store.objects.set("skill-market/details/" + sha256(JSON.stringify(detail)) + ".json", new TextEncoder().encode("{}"))
  const reader = createCatalogReader({ store: store.client, prefix: config.prefix })
  await expect(reader.detail(detail.source, detail.id)).rejects.toThrow("hash")
})

test("reads version-1 detail objects from their revision-specific key", async () => {
  const store = memoryObjectStore()
  const snapshot = sampleSnapshot("legacy")
  const catalogKey = "skill-market/indexes/legacy/catalog.json"
  const detailKey = "skill-market/indexes/legacy/details/skillhub/code-review.json"
  store.objects.set("skill-market/current.json", bytes({ revision: "legacy", createdAt: snapshot.createdAt }))
  store.objects.set(catalogKey, bytes({ revision: "legacy", createdAt: snapshot.createdAt, items: snapshot.items }))
  store.objects.set("skill-market/indexes/legacy/facets.json", bytes(snapshot.facets))
  store.objects.set(detailKey, bytes(snapshot.details.get("skillhub:code-review")))
  const reader = createCatalogReader({ store: store.client, prefix: config.prefix })
  expect((await reader.detail("skillhub", "code-review"))?.id).toBe("code-review")
  expect(store.reads.keys).toContain(detailKey)
})

function catalogIndex(revision: string, entries: ReadonlyArray<readonly [string, ReturnType<typeof sampleDetail>]>): CatalogIndex {
  const snapshot = sampleSnapshot(revision)
  const details = new Map(
    entries.map(([entryKey, detail]) => [
      entryKey,
      { key: `details/${sha256(JSON.stringify(detail))}.json`, sha256: sha256(JSON.stringify(detail)) },
    ] as const),
  )
  return {
    revision,
    createdAt: snapshot.createdAt,
    items: entries.map(([, detail]) => summary(detail)),
    details,
    facets: { ...snapshot.facets, revision },
    sourceStatus: snapshot.sourceStatus,
  }
}

function summary(detail: ReturnType<typeof sampleDetail>) {
  const { readme: _readme, author: _author, versions: _versions, securityReports: _securityReports, package: _package, ...value } = detail
  return value
}

function sha256(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function bytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value))
}

function memoryObjectStore() {
  const objects = new Map<string, Uint8Array>()
  const reads = { detail: 0, detailHead: 0, pointer: 0, index: 0, facets: 0, keys: [] as string[] }
  const state = { failDetailGets: 0 }
  const client: ObjectStore = {
    async put(key, body) {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
    },
    async get(key) {
      reads.keys.push(key)
      if (key.includes("/details/")) reads.detail++
      if (key.endsWith("/current.json")) reads.pointer++
      if (key.endsWith("/catalog.json")) reads.index++
      if (key.endsWith("/facets.json")) reads.facets++
      if (key.includes("/details/") && state.failDetailGets > 0) {
        state.failDetailGets--
        throw new Error("configured detail failure")
      }
      const value = objects.get(key)
      if (!value) throw new Error(`missing object ${key}`)
      return value
    },
    async head(key) {
      if (key.includes("/details/")) reads.detailHead++
      const value = objects.get(key)
      if (!value) throw new Error(`missing object ${key}`)
      return { size: value.byteLength }
    },
  }
  return {
    objects,
    reads,
    client,
    resetReads() {
      reads.detail = 0
      reads.detailHead = 0
      reads.pointer = 0
      reads.index = 0
      reads.facets = 0
      reads.keys = []
    },
    set failDetailGets(value: number) {
      state.failDetailGets = value
    },
  }
}
