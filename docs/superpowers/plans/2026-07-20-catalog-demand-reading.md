# Catalog Demand Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the 77,000-item catalog without downloading every detail object for list and facet requests.

**Architecture:** Restore a process-scoped `CatalogReader` that caches only the validated pointer/index/facets and loads one detail on demand. Keep full snapshot loading for synchronization, support both legacy V1 revision details and V2 content-addressed details, and inject the reader through both Effect and Web handlers.

**Tech Stack:** Bun, TypeScript, Effect HTTP API, Effect Schema, S3-compatible OSS, Bun test.

## Global Constraints

- Runtime dependencies keep their existing Schema/Protocol/Core/Server direction.
- Do not change public Protocol or generated Client code.
- Preserve V1 and V2 catalog compatibility.
- Do not cache the complete detail set.
- Run tests and `bun typecheck` only from `packages/skill-market-server`.
- Follow TDD: every production change follows a test that fails for the expected reason.

---

### Task 1: Restore index and single-detail OSS reads

**Files:**
- Modify: `packages/skill-market-server/src/catalog.ts`
- Modify: `packages/skill-market-server/src/oss.ts`
- Create: `packages/skill-market-server/src/catalog-reader.ts`
- Create: `packages/skill-market-server/test/catalog-reader.test.ts`

**Interfaces:**
- Produces: `CatalogIndex`, `queryCatalogIndex(...)`, `loadCatalogIndex(...)`, `loadCatalogDetail(...)`, `createCatalogReader(...)`, and `CatalogReader`.
- Consumes: existing `ObjectStore`, `SkillMarket.Summary`, `SkillMarket.Detail`, V1/V2 catalog objects, and `queryCatalog(...)` semantics.

- [ ] **Step 1: Write the failing 80,000-summary regression test**

Create a real in-memory `ObjectStore`, publish a V2-shaped pointer/index/facets plus one requested detail, call:

```ts
const reader = createCatalogReader({ store, prefix: "skill-market" })
expect((await reader.list({ page: 1, limit: 30, sort: "trending" })).items).toHaveLength(30)
expect(reads.detail).toBe(0)
expect((await reader.detail("skillhub", "skill-79999"))?.id).toBe("skill-79999")
expect(reads.detail).toBe(1)
```

Also add focused cases for V1 revision detail paths, V2 hash mismatch, concurrent detail coalescing, and index-cache reuse.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
bun test test/catalog-reader.test.ts
```

Expected: FAIL because `catalog-reader.ts`, `CatalogIndex`, `loadCatalogIndex`, and `loadCatalogDetail` do not exist.

- [ ] **Step 3: Add catalog index types and query delegation**

Add:

```ts
export interface CatalogDetailRef {
  readonly key: string
  readonly sha256: string
}

export interface CatalogIndex {
  readonly revision: string
  readonly createdAt: string
  readonly items: SkillMarket.Summary[]
  readonly details: ReadonlyMap<string, CatalogDetailRef>
  readonly facets: SkillMarket.Facets
  readonly sourceStatus: SkillMarket.SourceStatus
}
```

Move the existing filtering/sorting body into `queryCatalogIndex(index, query)`. Keep `queryCatalog(snapshot, query)` as a delegating compatibility function.

- [ ] **Step 4: Add V1/V2 index and detail readers**

In `oss.ts`, decode pointer, catalog, and facets without loading details. Build V2 refs from the catalog and V1 refs as revision-scoped paths. Add:

```ts
export async function loadCatalogIndex(client: ObjectStore, config: PublishConfig): Promise<CatalogIndex>
export async function loadCatalogDetail(
  client: ObjectStore,
  config: PublishConfig,
  index: CatalogIndex,
  source: SkillMarket.Source,
  id: string,
): Promise<SkillMarket.Detail | undefined>
```

V2 must validate `details/<sha256>.json` and the downloaded hash. V1 must read
`indexes/<revision>/details/<source>/<encoded-id>.json`. Both must validate the decoded source and ID.

- [ ] **Step 5: Implement the bounded reader**

Create `catalog-reader.ts` with:

```ts
export function createCatalogReader(options: {
  readonly store: ObjectStore
  readonly prefix: string
  readonly ttlMilliseconds?: number
})
```

Cache one index promise for 60 seconds, coalesce concurrent index and detail reads, and retain at most 512 decoded details using LRU insertion order.

- [ ] **Step 6: Run reader tests and verify GREEN**

Run:

```bash
bun test test/catalog-reader.test.ts
```

Expected: all reader tests PASS, including 80,000 summaries with zero detail reads.

- [ ] **Step 7: Commit the storage boundary**

```bash
git add packages/skill-market-server/src/catalog.ts \
  packages/skill-market-server/src/oss.ts \
  packages/skill-market-server/src/catalog-reader.ts \
  packages/skill-market-server/test/catalog-reader.test.ts
git commit -m "fix(skill-market): read catalog details on demand"
```

---

### Task 2: Inject CatalogReader through production HTTP

**Files:**
- Modify: `packages/skill-market-server/src/http/catalog.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Modify: `packages/skill-market-server/test/http.test.ts`
- Modify: `packages/skill-market-server/test/control-http.test.ts`

**Interfaces:**
- Consumes: `CatalogReader` from Task 1 and existing `CatalogPackageReader`.
- Produces: catalog routes where list/facets use only the index and detail/package routes load exactly one detail.

- [ ] **Step 1: Write the failing HTTP boundary test**

Inject a reader whose methods count calls. Assert:

```ts
await handler(new Request("https://market.example.com/v1/catalog/skills?page=1&limit=30"))
expect(calls.index).toBe(1)
expect(calls.list).toBe(1)
expect(calls.detail).toBe(0)
```

Then request detail, versions, download metadata, GET package, and HEAD package and assert each path asks for only the requested detail.

- [ ] **Step 2: Run HTTP tests and verify RED**

Run:

```bash
bun test test/http.test.ts test/control-http.test.ts
```

Expected: FAIL because handlers still require `loadSnapshot` and package delivery accesses `snapshot.details`.

- [ ] **Step 3: Convert catalog HTTP handlers**

Change `createCatalogHttp(...)` to accept `CatalogReader`. Use `catalog.list`, `catalog.facets`, and `catalog.detail`. Preserve revision/source headers by loading `catalog.index()` alongside each operation. Package GET/HEAD must call `catalog.detail(...)` before the existing package reader.

- [ ] **Step 4: Convert route options and server startup**

Replace `MarketHttpOptions.loadSnapshot` with `MarketHttpOptions.catalog`. In `server.ts`, construct exactly one:

```ts
const catalog = createCatalogReader({ store, prefix: config.ossPrefix })
```

Inject it into `createMarketRoutes(...)`. Keep synchronization imports and full snapshot loading unchanged.

- [ ] **Step 5: Convert the Web test handler**

Change `createCatalogHandler(...)` to accept the same reader boundary. Preserve OPTIONS short-circuiting, CORS, HEAD bodies, revision headers, malformed encoded path protection, and bounded package failures.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
bun test test/catalog-reader.test.ts test/http.test.ts test/control-http.test.ts
```

Expected: all tests PASS and list requests record zero detail reads.

- [ ] **Step 7: Commit production wiring**

```bash
git add packages/skill-market-server/src/http/catalog.ts \
  packages/skill-market-server/src/handlers.ts \
  packages/skill-market-server/src/server.ts \
  packages/skill-market-server/test/http.test.ts \
  packages/skill-market-server/test/control-http.test.ts
git commit -m "fix(skill-market): serve catalog from cached index"
```

---

### Task 3: Verify catalog performance and compatibility

**Files:**
- Modify only if a regression test exposes a missing assertion.

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: verification evidence for release.

- [ ] **Step 1: Run the performance regression**

```bash
bun test test/performance.test.ts test/catalog-reader.test.ts
```

Expected: the 80,000-summary query remains within the existing 300 ms p95 budget and no list request reads details.

- [ ] **Step 2: Run the complete package suite**

```bash
bun test
bun typecheck
```

Expected: zero failures and typecheck exit code 0.

- [ ] **Step 3: Verify the release build**

```bash
output="$(mktemp -d)/release"
bun run build:release "$output"
test -s "$output/packages/skill-market-server/src/server.ts"
test -s "$output/packages/skill-market-server/src/sync.ts"
```

Expected: immutable release build exits 0 with all runtime entrypoints.

