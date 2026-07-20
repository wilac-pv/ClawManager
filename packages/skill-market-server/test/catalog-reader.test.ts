import { expect, test } from "bun:test"
import { createCatalogReader } from "../src/catalog-reader"
import { key } from "../src/catalog"
import type { ObjectStore } from "../src/oss"
import { sampleDetail, sampleSnapshot } from "./fixture"

test("reads 80,000 summaries without fetching details and caches one requested detail", async () => {
  const store = memoryObjectStore()
  const details = Array.from({ length: 80_000 }, (_, index) =>
    sampleDetail({ id: `skill-${index}`, name: `Skill ${index}`, score: 80_000 - index }),
  )
  seedV2(store.objects, "large", details)
  const reader = createCatalogReader({ store: store.client, prefix: "skill-market", ttlMilliseconds: 60_000 })

  expect((await reader.list({ page: 1, limit: 30, sort: "trending" })).items).toHaveLength(30)
  expect(store.reads.detail).toBe(0)
  expect((await reader.detail("skillhub", "skill-79999"))?.id).toBe("skill-79999")
  expect(store.reads.detail).toBe(1)
  await reader.detail("skillhub", "skill-79999")
  expect(store.reads.detail).toBe(1)
  expect(store.reads.pointer).toBe(1)
  expect(store.reads.index).toBe(1)
  expect(store.reads.facets).toBe(1)
})

test("coalesces concurrent detail reads and clears a rejected request for retry", async () => {
  const store = memoryObjectStore()
  const detail = sampleDetail()
  seedV2(store.objects, "concurrent", [detail])
  const reader = createCatalogReader({ store: store.client, prefix: "skill-market" })

  const values = await Promise.all(Array.from({ length: 100 }, () => reader.detail(detail.source, detail.id)))
  expect(values.every((value) => value?.id === detail.id)).toBe(true)
  expect(store.reads.detail).toBe(1)
  expect(store.reads.pointer).toBe(1)
  expect(store.reads.index).toBe(1)
  expect(store.reads.facets).toBe(1)

  const retryStore = memoryObjectStore()
  seedV2(retryStore.objects, "retry", [detail])
  retryStore.failDetailGets = 1
  const retryReader = createCatalogReader({ store: retryStore.client, prefix: "skill-market" })
  await expect(
    Promise.all(Array.from({ length: 100 }, () => retryReader.detail(detail.source, detail.id))),
  ).rejects.toThrow("configured detail failure")
  expect((await retryReader.detail(detail.source, detail.id))?.id).toBe(detail.id)
  expect(retryStore.reads.detail).toBe(2)
})

test("refreshes the index after its TTL when the current pointer changes", async () => {
  const store = memoryObjectStore()
  const clock = { value: 1_000 }
  seedV2(store.objects, "first", [sampleDetail()])
  const reader = createCatalogReader({
    store: store.client,
    prefix: "skill-market",
    ttlMilliseconds: 60_000,
    now: () => clock.value,
  })

  expect((await reader.index()).revision).toBe("first")
  seedV2(store.objects, "second", [sampleDetail({ name: "Second" })])
  expect((await reader.index()).revision).toBe("first")
  clock.value += 60_001
  expect((await reader.index()).revision).toBe("second")
  expect(store.reads.pointer).toBe(2)
  expect(store.reads.index).toBe(2)
  expect(store.reads.facets).toBe(2)
})

test("evicts the least recently used detail after 512 cached entries", async () => {
  const store = memoryObjectStore()
  const details = Array.from({ length: 513 }, (_, index) =>
    sampleDetail({ id: `cached-${index}`, name: `Cached ${index}` }),
  )
  seedV2(store.objects, "eviction", details)
  const reader = createCatalogReader({ store: store.client, prefix: "skill-market" })

  await details.reduce(async (previous, detail) => {
    await previous
    await reader.detail(detail.source, detail.id)
  }, Promise.resolve())
  expect(store.reads.detail).toBe(513)
  await reader.detail(details[0]!.source, details[0]!.id)
  expect(store.reads.detail).toBe(514)
})

test("rejects a V2 detail whose body does not match its index hash", async () => {
  const store = memoryObjectStore()
  const detail = sampleDetail()
  seedV2(store.objects, "hash", [detail])
  store.objects.set(`skill-market/details/${sha256(JSON.stringify(detail))}.json`, bytes({}))

  await expect(
    createCatalogReader({ store: store.client, prefix: "skill-market" }).detail(detail.source, detail.id),
  ).rejects.toThrow("hash")
})

test("rejects a detail whose version does not match its index summary", async () => {
  const store = memoryObjectStore()
  const detail = sampleDetail({ version: "1.0.0" })
  seedV2(store.objects, "version", [detail])
  const changed = sampleDetail({ version: "2.0.0" })
  const digest = sha256(JSON.stringify(changed))
  store.objects.set(`skill-market/details/${digest}.json`, bytes(changed))
  store.objects.set(
    "skill-market/indexes/version/catalog.json",
    bytes({
      schemaVersion: 2,
      revision: "version",
      createdAt: sampleSnapshot("version").createdAt,
      items: [{ summary: summary(detail), detail: { key: `details/${digest}.json`, sha256: digest } }],
    }),
  )

  await expect(
    createCatalogReader({ store: store.client, prefix: "skill-market" }).detail(detail.source, detail.id),
  ).rejects.toThrow("does not match")
})

test("reads V1 detail objects from their revision-specific key", async () => {
  const store = memoryObjectStore()
  const snapshot = sampleSnapshot("legacy")
  store.objects.set("skill-market/current.json", bytes({ revision: "legacy", createdAt: snapshot.createdAt }))
  store.objects.set(
    "skill-market/indexes/legacy/catalog.json",
    bytes({ revision: "legacy", createdAt: snapshot.createdAt, items: snapshot.items }),
  )
  store.objects.set("skill-market/indexes/legacy/facets.json", bytes(snapshot.facets))
  store.objects.set(
    "skill-market/indexes/legacy/details/skillhub/code-review.json",
    bytes(snapshot.details.get("skillhub:code-review")),
  )

  expect(
    (await createCatalogReader({ store: store.client, prefix: "skill-market" }).detail("skillhub", "code-review"))?.id,
  ).toBe("code-review")
  expect(store.reads.keys).toContain("skill-market/indexes/legacy/details/skillhub/code-review.json")
})

test("rejects duplicate V1 catalog keys", async () => {
  const store = memoryObjectStore()
  const snapshot = sampleSnapshot("duplicate")
  store.objects.set("skill-market/current.json", bytes({ revision: "duplicate", createdAt: snapshot.createdAt }))
  store.objects.set(
    "skill-market/indexes/duplicate/catalog.json",
    bytes({ revision: "duplicate", createdAt: snapshot.createdAt, items: [snapshot.items[0], snapshot.items[0]] }),
  )
  store.objects.set("skill-market/indexes/duplicate/facets.json", bytes(snapshot.facets))

  await expect(
    createCatalogReader({ store: store.client, prefix: "skill-market" }).list({
      page: 1,
      limit: 30,
      sort: "trending",
    }),
  ).rejects.toThrow("duplicate")
})

function seedV2(
  objects: Map<string, Uint8Array>,
  revision: string,
  details: ReadonlyArray<ReturnType<typeof sampleDetail>>,
) {
  const snapshot = sampleSnapshot(revision)
  objects.set("skill-market/current.json", bytes({ revision, createdAt: snapshot.createdAt }))
  objects.set(
    `skill-market/indexes/${revision}/catalog.json`,
    bytes({
      schemaVersion: 2,
      revision,
      createdAt: snapshot.createdAt,
      items: details.map((detail) => ({
        summary: summary(detail),
        detail: { key: `details/${sha256(JSON.stringify(detail))}.json`, sha256: sha256(JSON.stringify(detail)) },
      })),
    }),
  )
  objects.set(
    `skill-market/indexes/${revision}/facets.json`,
    bytes({ ...snapshot.facets, revision, sourceStatus: snapshot.sourceStatus }),
  )
  details.forEach((detail) => objects.set(`skill-market/details/${sha256(JSON.stringify(detail))}.json`, bytes(detail)))
}

function summary(detail: ReturnType<typeof sampleDetail>) {
  const {
    readme: _readme,
    author: _author,
    versions: _versions,
    securityReports: _securityReports,
    package: _package,
    ...value
  } = detail
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
  const reads = { detail: 0, pointer: 0, index: 0, facets: 0, keys: [] as string[] }
  const state = { failDetailGets: 0 }
  const client: ObjectStore = {
    async put(key, body) {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
    },
    async get(objectKey) {
      reads.keys.push(objectKey)
      if (objectKey.includes("/details/")) reads.detail++
      if (objectKey.endsWith("/current.json")) reads.pointer++
      if (objectKey.endsWith("/catalog.json")) reads.index++
      if (objectKey.endsWith("/facets.json")) reads.facets++
      if (objectKey.includes("/details/") && state.failDetailGets > 0) {
        state.failDetailGets--
        throw new Error("configured detail failure")
      }
      const value = objects.get(objectKey)
      if (!value) throw new Error(`missing object ${objectKey}`)
      return value
    },
    async head(objectKey) {
      const value = objects.get(objectKey)
      if (!value) throw new Error(`missing object ${objectKey}`)
      return { size: value.byteLength }
    },
  }
  return {
    objects,
    reads,
    client,
    set failDetailGets(value: number) {
      state.failDetailGets = value
    },
  }
}
