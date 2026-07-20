# SkillHub Full Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror every recoverable SkillHub package into OSS with resumable processing, bounded adaptive concurrency, scalable content-addressed catalogs, and administrator-visible progress.

**Architecture:** A SQLite-backed discovery and mirror queue separates long-running upstream work from short catalog publications. Packages and details are content-addressed in OSS; the API caches the summary index and loads one detail on demand. Existing HTTP response models remain compatible while an admin-only control API and Web panel expose progress and pause/resume/retry operations.

**Tech Stack:** Bun, TypeScript, Bun SQLite, Effect Schema/HttpApi, AWS S3 client against OSS, SolidJS, TanStack Query, Bun Test, Playwright.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-17-skillhub-full-mirror-design.md` exactly.
- Keep ZIP path, compressed-size, expanded-size, file-count, readable-content, and explicit-malware rejection enabled.
- Use defaults: page concurrency 4, metadata concurrency 8, package concurrency 6, publish every 2,000 new mirrors or 30 minutes.
- Keep public catalog request and response models compatible with the current Web and desktop clients.
- Preserve dependencies from Schema to Core/Protocol, and from Core/Protocol to Server; Client runtime code must not depend on Core or Server.
- After changing public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`; never edit `src/generated` or `src/generated-effect` directly.
- Run tests and `bun typecheck` from package directories, never from the repository root and never invoke `tsc` directly.
- Follow the repository import, control-flow, variable, and Effect-generator style in `AGENTS.md`.
- Do not alter or stage the user's untracked `.superpowers/brainstorm/` directory.

---

## File Structure

- `packages/schema/src/skill-market-control.ts`: admin progress, command, and audit schemas.
- `packages/protocol/src/groups/skill-market-admin.ts`: admin progress and command endpoints.
- `packages/skill-market-server/migrations/003_skillhub_import.sql`: persistent generations and import items.
- `packages/skill-market-server/src/skillhub-import-store.ts`: SQLite queue, leases, progress, commands, and mirrored catalog rows.
- `packages/skill-market-server/src/adaptive-pool.ts`: reusable bounded adaptive concurrency controller.
- `packages/skill-market-server/src/skillhub.ts`: page and one-record SkillHub adapter operations.
- `packages/skill-market-server/src/skillhub-discovery.ts`: resumable page discovery and stability sweeps.
- `packages/skill-market-server/src/skillhub-archive.ts`: safe normalization, ZIP rewriting, repairs, and actual manifest generation.
- `packages/skill-market-server/src/skillhub-mirror.ts`: one-item fetch, normalize, mirror, and persistence workflow.
- `packages/skill-market-server/src/skillhub-worker.ts`: time-bounded discovery/mirror/publication entrypoint.
- `packages/skill-market-server/src/catalog-reader.ts`: revision-aware summary cache and on-demand detail cache.
- `packages/skill-market-server/src/catalog.ts`: summary-plus-detail-reference catalog representation and queries.
- `packages/skill-market-server/src/oss.ts`: content-addressed detail objects and version-2 index format with version-1 compatibility.
- `packages/skill-market-server/src/publisher.ts`: short catalog leases and delta-object publication.
- `packages/skill-market-server/src/community.ts`: content-addressed community detail publication.
- `packages/skill-market-server/src/sync.ts`: enterprise/community refresh without all-SkillHub refetching.
- `packages/skill-market-server/src/skillhub-import-admin.ts`: admin progress and audited commands.
- `packages/skill-market-server/src/http/admin.ts`: HttpApi handlers for import administration.
- `packages/skill-market-web/src/admin/skillhub.tsx`: progress panel and controls.
- `packages/skill-market-web/src/control-data-source.ts`: import progress/command client.
- `packages/skill-market-server/deploy/systemd/ruying-skill-market-skillhub.service`: isolated oneshot worker.
- `packages/skill-market-server/deploy/systemd/ruying-skill-market-skillhub.timer`: recurring worker schedule.

---

### Task 1: Add Admin Control Contracts

**Files:**
- Modify: `packages/schema/src/skill-market-control.ts`
- Modify: `packages/protocol/src/groups/skill-market-admin.ts`
- Modify: `packages/protocol/test/skill-market-control.test.ts`
- Regenerate: `packages/client/src/generated/**`
- Regenerate: `packages/client/src/generated-effect/**`

**Interfaces:**
- Produces: `SkillMarketControl.SkillHubImportProgress`, `SkillHubImportCommandInput`, and two admin operations named `skillMarket.admin.skillhub.status` and `skillMarket.admin.skillhub.command`.
- Consumes: existing `SkillMarket.Timestamp`, `SkillMarketControl.Role`, problem responses, and admin middleware.

- [ ] **Step 1: Write the failing Protocol contract test**

Add these exact rows to the expected operation list in `packages/protocol/test/skill-market-control.test.ts`:

```ts
["skillMarket.admin.skillhub.status", "GET", "/v1/admin/skillhub-import"],
["skillMarket.admin.skillhub.command", "POST", "/v1/admin/skillhub-import/command"],
```

Also decode a representative progress payload:

```ts
expect(
  Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportProgress)({
    state: "running",
    sourceStatus: "stale",
    upstreamTotal: 78_253,
    discovered: 10_000,
    pending: 7_000,
    running: 6,
    mirrored: 2_900,
    retryWait: 90,
    rejected: 4,
    uploadedBytes: 1_048_576,
    ratePerMinute: 120,
    estimatedSecondsRemaining: 37_676,
    discoveryPage: 100,
    sweep: 1,
    metadataConcurrency: 8,
    packageConcurrency: 6,
    updatedAt: "2026-07-17T00:00:00.000Z",
  }).mirrored,
).toBe(2_900)
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test test/skill-market-control.test.ts` from `packages/protocol`.

Expected: FAIL because `SkillHubImportProgress` and both endpoint names do not exist.

- [ ] **Step 3: Add the Schema contracts**

Add these exported schemas and types to `packages/schema/src/skill-market-control.ts`:

```ts
export const SkillHubImportState = Schema.Literals(["idle", "running", "paused", "completed", "failed"])
export type SkillHubImportState = typeof SkillHubImportState.Type

export const SkillHubImportCommand = Schema.Literals(["pause", "resume", "retry-wait", "retry-rejected"])
export type SkillHubImportCommand = typeof SkillHubImportCommand.Type

export const SkillHubImportCommandInput = Schema.Struct({
  command: SkillHubImportCommand,
}).annotate({ identifier: "SkillMarketControl.SkillHubImportCommandInput" })
export type SkillHubImportCommandInput = typeof SkillHubImportCommandInput.Type

export const SkillHubImportProgress = Schema.Struct({
  state: SkillHubImportState,
  sourceStatus: Schema.Literals(["fresh", "stale", "unavailable"]),
  upstreamTotal: NonNegative,
  discovered: NonNegative,
  pending: NonNegative,
  running: NonNegative,
  mirrored: NonNegative,
  retryWait: NonNegative,
  rejected: NonNegative,
  uploadedBytes: NonNegative,
  ratePerMinute: NonNegative,
  estimatedSecondsRemaining: NonNegative.pipe(optional),
  discoveryPage: NonNegative,
  sweep: NonNegative,
  metadataConcurrency: Positive,
  packageConcurrency: Positive,
  updatedAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.SkillHubImportProgress" })
export type SkillHubImportProgress = typeof SkillHubImportProgress.Type
```

Extend `AuditAction` with `skillhub-import-paused`, `skillhub-import-resumed`, `skillhub-import-retried`, and extend `AuditObjectType` with `skillhub_import`.

- [ ] **Step 4: Add the HttpApi endpoints**

Append admin-only endpoints to `SkillMarketAdminGroup` in `packages/protocol/src/groups/skill-market-admin.ts`:

```ts
HttpApiEndpoint.get("skillMarket.admin.skillhub.status", "/v1/admin/skillhub-import", {
  success: SkillMarketControl.SkillHubImportProgress,
  error: [SkillMarketForbidden, SkillMarketDependencyUnavailable],
}),
HttpApiEndpoint.post("skillMarket.admin.skillhub.command", "/v1/admin/skillhub-import/command", {
  payload: SkillMarketControl.SkillHubImportCommandInput,
  success: SkillMarketControl.SkillHubImportProgress,
  error: [SkillMarketForbidden, SkillMarketInvalidRequest, SkillMarketDependencyUnavailable],
}),
```

- [ ] **Step 5: Generate clients and verify GREEN**

Run `bun run generate` from `packages/client`.

Then run:

```bash
cd packages/schema && bun typecheck
cd ../protocol && bun test test/skill-market-control.test.ts && bun typecheck
cd ../client && bun typecheck
```

Expected: all commands exit 0 and generated clients include both new operation names.

- [ ] **Step 6: Commit**

```bash
git add packages/schema/src/skill-market-control.ts packages/protocol/src/groups/skill-market-admin.ts packages/protocol/test/skill-market-control.test.ts packages/client/src/generated packages/client/src/generated-effect
git commit -m "feat(skill-market): add import control contracts"
```

---

### Task 2: Persist Import Generations and Item Leases

**Files:**
- Create: `packages/skill-market-server/migrations/003_skillhub_import.sql`
- Create: `packages/skill-market-server/src/skillhub-import-store.ts`
- Create: `packages/skill-market-server/test/skillhub-import-store.test.ts`
- Modify: `packages/skill-market-server/test/database.test.ts`

**Interfaces:**
- Produces: `createSkillHubImportStore(options)`, whose result exposes `beginGeneration`, `recordPage`, `completeSweep`, `claim`, `complete`, `retry`, `reject`, `progress`, `command`, `mirroredEntries`, and `seedLegacy`.
- Consumes: `MarketDatabase`, `SkillHubListRecord`, `SkillMarket.Detail`, and injected `now()`.

- [ ] **Step 1: Write failing migration and lease tests**

Create `test/skillhub-import-store.test.ts` with a temporary database and assert this sequence:

```ts
const store = createSkillHubImportStore({ database, now: () => clock.value })
const generation = store.beginGeneration(78_253)
store.recordPage(generation.id, 1, [listRecord("alpha", "1.0.0")])
const claimed = store.claim("worker-a", 6, 60_000)
expect(claimed.map((item) => item.slug)).toEqual(["alpha"])
expect(store.claim("worker-b", 6, 60_000)).toEqual([])
clock.value += 60_001
expect(store.claim("worker-b", 6, 60_000).map((item) => item.slug)).toEqual(["alpha"])
```

Add tests that `complete` stores summary/detail references, `retry` sets `next_attempt_at`, `reject` stores a bounded error, `resume` changes paused state to running, and recording the same `slug + version + updated_at` leaves an existing mirrored item unchanged.

- [ ] **Step 2: Run the test and verify RED**

Run: `bun test test/skillhub-import-store.test.ts test/database.test.ts` from `packages/skill-market-server`.

Expected: FAIL because migration 003 and `skillhub-import-store.ts` are absent.

- [ ] **Step 3: Add the migration**

Create `003_skillhub_import.sql` with two STRICT tables and queue indexes:

```sql
CREATE TABLE skillhub_generations (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'completed', 'failed')),
  upstream_total INTEGER NOT NULL CHECK (upstream_total >= 0),
  discovery_page INTEGER NOT NULL DEFAULT 0 CHECK (discovery_page >= 0),
  sweep INTEGER NOT NULL DEFAULT 0 CHECK (sweep >= 0),
  new_in_sweep INTEGER NOT NULL DEFAULT 0 CHECK (new_in_sweep >= 0),
  last_published_count INTEGER NOT NULL DEFAULT 0 CHECK (last_published_count >= 0),
  uploaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_bytes >= 0),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (updated_at >= started_at),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
) STRICT;

CREATE TABLE skillhub_import_items (
  slug TEXT PRIMARY KEY CHECK (length(slug) BETWEEN 1 AND 256),
  generation_id TEXT NOT NULL REFERENCES skillhub_generations(id),
  upstream_version TEXT NOT NULL,
  upstream_updated_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'mirrored', 'retry_wait', 'rejected')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  list_json TEXT NOT NULL CHECK (json_valid(list_json)),
  record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json)),
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  detail_key TEXT,
  detail_sha256 TEXT CHECK (detail_sha256 IS NULL OR length(detail_sha256) = 64),
  original_package_sha256 TEXT CHECK (original_package_sha256 IS NULL OR length(original_package_sha256) = 64),
  package_sha256 TEXT CHECK (package_sha256 IS NULL OR length(package_sha256) = 64),
  package_size INTEGER CHECK (package_size IS NULL OR package_size > 0),
  repair_json TEXT CHECK (repair_json IS NULL OR json_valid(repair_json)),
  error_code TEXT,
  error_summary TEXT,
  last_seen_generation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
) STRICT;

CREATE INDEX skillhub_import_queue ON skillhub_import_items(state, next_attempt_at, lease_expires_at, updated_at);
CREATE INDEX skillhub_import_generation ON skillhub_import_items(last_seen_generation, state);
CREATE INDEX skillhub_import_detail ON skillhub_import_items(detail_key) WHERE detail_key IS NOT NULL;
```

- [ ] **Step 4: Implement the store**

Use one `MarketDatabase.transaction` for every state transition. Export these exact input/result shapes:

```ts
export interface ClaimedSkillHubItem {
  readonly slug: string
  readonly upstreamVersion: string
  readonly upstreamUpdatedAt: number
  readonly list: SkillHubListRecord
}

export interface MirroredSkillHubEntry {
  readonly summary: SkillMarket.Summary
  readonly detailKey: string
  readonly detailSha256: string
}

export interface CompletedSkillHubImport {
  readonly entry: MirroredSkillHubEntry
  readonly record: SkillHubRecord
  readonly originalPackageSha256: string
  readonly packageSha256: string
  readonly packageSize: number
  readonly repairs: readonly string[]
}

export interface SkillHubImportStore {
  readonly beginGeneration: (upstreamTotal: number) => { readonly id: string }
  readonly recordPage: (generationID: string, page: number, items: readonly SkillHubListRecord[]) => { readonly inserted: number }
  readonly completeSweep: (generationID: string) => { readonly stable: boolean }
  readonly claim: (workerID: string, limit: number, leaseMilliseconds: number) => ClaimedSkillHubItem[]
  readonly complete: (workerID: string, slug: string, result: CompletedSkillHubImport) => boolean
  readonly retry: (workerID: string, slug: string, code: string, summary: string, retryAt: number) => boolean
  readonly reject: (workerID: string, slug: string, code: string, summary: string) => boolean
  readonly progress: () => SkillMarketControl.SkillHubImportProgress
  readonly command: (input: SkillMarketControl.SkillHubImportCommandInput) => SkillMarketControl.SkillHubImportProgress
  readonly mirroredEntries: () => MirroredSkillHubEntry[]
  readonly seedLegacy: (entries: readonly MirroredSkillHubEntry[]) => number
}

export function createSkillHubImportStore(options: {
  readonly database: MarketDatabase
  readonly now?: () => number
  readonly metadataConcurrency?: number
  readonly packageConcurrency?: number
}): SkillHubImportStore
```

`claim` must atomically select eligible `pending`, due `retry_wait`, or expired `running` rows and update only those rows to `running`. `complete`, `retry`, and `reject` must require the matching lease owner. Bound `error_summary` to 500 characters before storing it. `progress` must calculate state counts in SQL and decode the public result with `SkillMarketControl.SkillHubImportProgress`.

- [ ] **Step 5: Verify GREEN and database integrity**

Run:

```bash
bun test test/skillhub-import-store.test.ts test/database.test.ts
bun typecheck
```

Expected: all tests pass; migration backup and `PRAGMA integrity_check` tests remain green.

- [ ] **Step 6: Commit**

```bash
git add migrations/003_skillhub_import.sql src/skillhub-import-store.ts test/skillhub-import-store.test.ts test/database.test.ts
git commit -m "feat(skill-market): persist SkillHub imports"
```

---

### Task 3: Discover All Pages with Adaptive Bounded Concurrency

**Files:**
- Create: `packages/skill-market-server/src/adaptive-pool.ts`
- Create: `packages/skill-market-server/src/skillhub-discovery.ts`
- Create: `packages/skill-market-server/test/skillhub-discovery.test.ts`
- Modify: `packages/skill-market-server/src/skillhub.ts`
- Modify: `packages/skill-market-server/test/sources.test.ts`

**Interfaces:**
- Produces: `loadSkillHubPage(fetcher, baseUrl, page)`, `loadSkillHubRecord(fetcher, baseUrl, item)`, `createAdaptivePool`, and `discoverSkillHub(options)`.
- Consumes: `SkillHubImportStore.recordPage/completeSweep`, injected fetcher, and upstream `Retry-After` headers.

- [ ] **Step 1: Write failing bounded-concurrency tests**

In `test/skillhub-discovery.test.ts`, use an injected fetcher that tracks active requests and returns 801 synthetic records over nine pages. Assert:

```ts
const result = await discoverSkillHub({
  fetcher,
  baseUrl: "https://api.skillhub.cn",
  imports,
  pageConcurrency: 4,
  metadataConcurrency: 8,
  now: () => clock.value,
})
expect(result.discovered).toBe(801)
expect(fetchState.maximumActive).toBeLessThanOrEqual(4)
```

Add a 429 response with `Retry-After: 1`, advance an injected scheduler instead of sleeping, and assert the page is retried while maximum active concurrency drops. Add two sweeps where the second discovers no new slug and assert the generation becomes discovery-complete; add an unstable third sweep and assert it remains stale without delisting unseen rows.

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test test/skillhub-discovery.test.ts test/sources.test.ts` from `packages/skill-market-server`.

Expected: FAIL because page-level adapter functions, the adaptive pool, and discovery service do not exist.

- [ ] **Step 3: Split page and record operations from the existing adapter**

Export these types/functions from `src/skillhub.ts` without changing field normalization:

```ts
export type SkillHubListRecord = typeof ListSkill.Type
export type SkillHubPage = typeof ListResponse.Type

export function loadSkillHubPage(fetcher: Fetcher, input: string, page: number): Promise<SkillHubPage>
export function loadSkillHubRecord(
  fetcher: Fetcher,
  input: string,
  skill: SkillHubListRecord,
): Promise<SkillHubRecord>
```

Keep `loadSkillHub` as a compatibility wrapper for existing focused tests, but implement it through the exported functions and bounded page batches instead of one unbounded `Promise.all`.

- [ ] **Step 4: Implement adaptive concurrency and retry**

`createAdaptivePool` accepts `{ minimum, maximum, now, wait }`. It starts at `maximum`, halves the current limit on 429 or repeated timeout, honors an integer-seconds or HTTP-date `Retry-After`, and increments by one after five throttle-free minutes. It exposes:

```ts
export interface AdaptivePool {
  readonly concurrency: () => number
  readonly map: <Input, Output>(values: readonly Input[], run: (value: Input) => Promise<Output>) => Promise<Output[]>
}
```

Retry only network errors, 429, and 5xx. Schema failures and other 4xx responses must remain permanent page errors.

- [ ] **Step 5: Implement resumable discovery**

`discoverSkillHub` must read the current generation cursor, fetch at most the configured page batch, store each successful page immediately, and update the page cursor. When a sweep ends, start another sweep from page 1; finish discovery only after a sweep reports `newInSweep === 0` and the observed unique count covers the current upstream total. Do not hold a database transaction while awaiting network I/O.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
bun test test/skillhub-discovery.test.ts test/sources.test.ts
bun typecheck
```

Expected: all tests pass, maximum observed concurrency is 4, and the old adapter normalization test remains green.

- [ ] **Step 7: Commit**

```bash
git add src/adaptive-pool.ts src/skillhub-discovery.ts src/skillhub.ts test/skillhub-discovery.test.ts test/sources.test.ts
git commit -m "fix(skill-market): bound SkillHub discovery"
```

---

### Task 4: Normalize Recoverable SkillHub Archives

**Files:**
- Create: `packages/skill-market-server/src/skillhub-archive.ts`
- Create: `packages/skill-market-server/test/skillhub-archive.test.ts`
- Modify: `packages/skill-market-server/src/submission-archive.ts`
- Modify: `packages/skill-market-server/test/zip.ts`
- Modify: `packages/skill-market-server/src/sync.ts`
- Modify: `packages/skill-market-server/test/sync.test.ts`

**Interfaces:**
- Produces: `normalizeSkillHubArchive(body, record)` returning normalized bytes, actual files, safe ID, description, readme, license, and repair codes.
- Consumes: `inspectZipArchive`, `SkillHubRecord`, `gray-matter`, `node:zlib` deflate support, and existing archive limits.

- [ ] **Step 1: Write failing compatibility and hard-rejection tests**

Cover these exact cases in `test/skillhub-archive.test.ts`:

```ts
expect(normalizeSkillHubArchive(zip({ name: undefined }), record("safe-slug")).id).toBe("safe-slug")
expect(normalizeSkillHubArchive(zip({ name: "中文 名称" }), record("safe-slug")).repairs).toContain("name-replaced")
expect(normalizeSkillHubArchive(nestedZip("folder/SKILL.md"), record("safe-slug")).repairs).toContain("root-promoted")
expect(() => normalizeSkillHubArchive(traversalZip(), record("safe-slug"))).toThrow("ZIP path")
expect(() => normalizeSkillHubArchive(oversizedZip(), record("safe-slug"))).toThrow("expanded size")
expect(() => normalizeSkillHubArchive(noRecoverableSkillZip(), record("safe-slug"))).toThrow("recoverable SKILL.md")
```

Also assert the normalized ZIP can be read again by `inspectZipArchive`, its computed SHA-256 matches the returned package hash, and its actual manifest is independent of the incorrect SkillHub manifest.

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test test/skillhub-archive.test.ts test/sync.test.ts` from `packages/skill-market-server`.

Expected: FAIL because normalization and ZIP rewriting are absent.

- [ ] **Step 3: Expose complete safe archive entries**

Export the archive entry type from `submission-archive.ts` and call `inspectZipArchive` with `retainedContent: Number.POSITIVE_INFINITY` only inside normalization. Preserve the existing 50 MiB compressed, 100 MiB expanded, 1,000-file, path, duplicate, CRC, symlink, and readable UTF-8 checks required by the design.

- [ ] **Step 4: Implement deterministic ZIP rewriting**

Build normalized ZIPs with sorted paths, UTF-8 names, DEFLATE entries from `node:zlib`, fixed DOS timestamps, regular-file mode `0o100644`, recalculated CRC32, and a new central directory. Export:

```ts
export interface NormalizedSkillHubArchive {
  readonly id: string
  readonly description: string
  readonly readme: string
  readonly license?: string
  readonly body: Uint8Array
  readonly sha256: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string; readonly size: number }>
  readonly repairs: ReadonlyArray<"name-replaced" | "description-added" | "manifest-rebuilt" | "root-promoted">
}

export function normalizeSkillHubArchive(body: Uint8Array, record: SkillHubRecord): NormalizedSkillHubArchive
```

Use a safe SkillHub slug only when it matches `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`; otherwise derive a lowercase ASCII identifier from the slug plus the first 12 characters of its SHA-256. Rewrite only the YAML frontmatter and preserve the Markdown body. Promote a nested Skill directory only when exactly one `SKILL.md` candidate exists.

- [ ] **Step 5: Replace strict SkillHub manifest equality**

In `sync.ts`, make existing focused synchronization call the normalizer. Treat a SkillHub manifest mismatch as repair metadata instead of an error, while retaining hard archive errors. Do not weaken enterprise or community submission validation.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
bun test test/skillhub-archive.test.ts test/sync.test.ts test/submission-archive.test.ts
bun typecheck
```

Expected: compatibility cases pass; existing traversal, CRC, zip-bomb, and submission tests remain green.

- [ ] **Step 7: Commit**

```bash
git add src/skillhub-archive.ts src/submission-archive.ts src/sync.ts test/skillhub-archive.test.ts test/submission-archive.test.ts test/sync.test.ts test/zip.ts
git commit -m "feat(skill-market): normalize SkillHub archives"
```

---

### Task 5: Mirror Claimed Items to Content-Addressed OSS

**Files:**
- Create: `packages/skill-market-server/src/skillhub-mirror.ts`
- Create: `packages/skill-market-server/src/skillhub-worker.ts`
- Create: `packages/skill-market-server/test/skillhub-mirror.test.ts`
- Modify: `packages/skill-market-server/src/config.ts`
- Modify: `packages/skill-market-server/test/sources.test.ts`
- Modify: `packages/skill-market-server/package.json`

**Interfaces:**
- Produces: `createSkillHubMirror(options).runBatch(workerID)` and a `skillhub-worker` package script.
- Consumes: import store claims, SkillHub record adapter, archive normalizer, object store, adaptive pools, and catalog publication callback.

- [ ] **Step 1: Write failing mirror tests**

Use a real temporary SQLite database and an in-memory `PrivateObjectStore`. Seed six items, return two identical normalized ZIPs, one 429-then-success, one explicit malicious report, one traversal ZIP, and one normal package. Assert:

```ts
expect(result).toEqual({ mirrored: 4, retryWait: 0, rejected: 2 })
expect(objects.keys().filter((key) => key.includes("/packages/")).toHaveLength(3)
expect(imports.progress().packageConcurrency).toBeLessThanOrEqual(6)
```

Assert explicit malicious and traversal entries are `rejected`; transient OSS failure is `retry_wait`; restarting `runBatch` does not upload completed SHA objects again.

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test test/skillhub-mirror.test.ts test/sources.test.ts` from `packages/skill-market-server`.

Expected: FAIL because mirror service, worker entrypoint, and concurrency config are absent.

- [ ] **Step 3: Add validated configuration**

Extend `loadConfig` with positive integer settings and these defaults:

```ts
skillhubPageConcurrency: positiveInteger("SKILL_MARKET_SKILLHUB_PAGE_CONCURRENCY", environment.SKILL_MARKET_SKILLHUB_PAGE_CONCURRENCY ?? "4"),
skillhubMetadataConcurrency: positiveInteger("SKILL_MARKET_SKILLHUB_METADATA_CONCURRENCY", environment.SKILL_MARKET_SKILLHUB_METADATA_CONCURRENCY ?? "8"),
skillhubPackageConcurrency: positiveInteger("SKILL_MARKET_SKILLHUB_PACKAGE_CONCURRENCY", environment.SKILL_MARKET_SKILLHUB_PACKAGE_CONCURRENCY ?? "6"),
skillhubPublishBatch: positiveInteger("SKILL_MARKET_SKILLHUB_PUBLISH_BATCH", environment.SKILL_MARKET_SKILLHUB_PUBLISH_BATCH ?? "2000"),
skillhubPublishMinutes: positiveInteger("SKILL_MARKET_SKILLHUB_PUBLISH_MINUTES", environment.SKILL_MARKET_SKILLHUB_PUBLISH_MINUTES ?? "30"),
skillhubMemorySoftLimitMb: positiveInteger("SKILL_MARKET_SKILLHUB_MEMORY_SOFT_LIMIT_MB", environment.SKILL_MARKET_SKILLHUB_MEMORY_SOFT_LIMIT_MB ?? "1536"),
```

Cap page concurrency at 16, metadata at 32, package at 12, and reject a memory soft limit below 512 MiB.

- [ ] **Step 4: Implement one-item and batch mirroring**

For each claim: load record metadata, reject when any security report verdict is `danger`, download with the existing host allowlist and 50 MiB limit, normalize, PUT `packages/<sha256>.zip` only when `head` does not already match, mirror an allowed icon, create a `SkillMarket.Detail`, hash its JSON, PUT `details/<sha256>.json`, and complete the leased row with summary/detail references and repair JSON.

Classify errors as:

```ts
type MirrorFailure =
  | { readonly kind: "retry"; readonly code: string; readonly retryAt: number }
  | { readonly kind: "reject"; readonly code: string }
```

Network, 429, 5xx, and OSS errors retry; unsafe archive, unreadable archive, no recoverable Skill, and explicit malware reject. Stop claiming new items when RSS exceeds the configured soft limit, but finish already claimed items.

- [ ] **Step 5: Add the worker entrypoint**

`src/skillhub-worker.ts` must open the configured database and store, recover expired claims, run one bounded discovery slice, run mirror batches until 50 seconds have elapsed or no eligible item remains, publish only when the threshold callback says it is due, emit metrics, and close the database in both success and failure paths. Add:

```json
"skillhub-worker": "bun src/skillhub-worker.ts"
```

- [ ] **Step 6: Verify GREEN**

Run:

```bash
bun test test/skillhub-mirror.test.ts test/sources.test.ts
bun typecheck
```

Expected: all tests pass, package PUT count is deduplicated, and no secret appears in captured logs.

- [ ] **Step 7: Commit**

```bash
git add src/skillhub-mirror.ts src/skillhub-worker.ts src/config.ts test/skillhub-mirror.test.ts test/sources.test.ts package.json
git commit -m "feat(skill-market): mirror SkillHub packages"
```

---

### Task 6: Publish and Read Scalable Catalog Version 2

**Files:**
- Create: `packages/skill-market-server/src/catalog-reader.ts`
- Create: `packages/skill-market-server/test/catalog-reader.test.ts`
- Modify: `packages/skill-market-server/src/catalog.ts`
- Modify: `packages/skill-market-server/src/oss.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/http/catalog.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Modify: `packages/skill-market-server/test/oss.test.ts`
- Modify: `packages/skill-market-server/test/http.test.ts`
- Modify: `packages/skill-market-server/test/performance.test.ts`

**Interfaces:**
- Produces: `CatalogIndex`, `CatalogDetailRef`, `publishCatalogIndex`, `loadCatalogIndex`, and `createCatalogReader`.
- Consumes: existing `SkillMarket.Summary`, `SkillMarket.Detail`, OSS pointer, and catalog query normalization.

- [ ] **Step 1: Write failing version-2 and 80,000-item tests**

Create a version-2 index with 80,000 summaries and detail references. Count object-store reads and assert:

```ts
const reader = createCatalogReader({ store, prefix: "skill-market", ttlMilliseconds: 60_000 })
expect((await reader.list({ page: 1, limit: 30, sort: "trending" })).items).toHaveLength(30)
expect(reads.detail).toBe(0)
await reader.detail("skillhub", "skill-79999")
expect(reads.detail).toBe(1)
await reader.detail("skillhub", "skill-79999")
expect(reads.detail).toBe(1)
```

Add a publisher test that changes one of 80,000 entries and asserts one changed detail PUT, one index PUT, one facets PUT, and one pointer PUT rather than 80,000 detail PUTs. Preserve a version-1 fixture and assert it remains readable.

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test test/catalog-reader.test.ts test/oss.test.ts test/http.test.ts test/performance.test.ts` from `packages/skill-market-server`.

Expected: FAIL because the reader and index-v2 schemas do not exist and current reads fetch every detail.

- [ ] **Step 3: Introduce the internal index model**

Add internal types without changing public Schema:

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

Move list filtering/sorting to `queryCatalogIndex(index, query)`. Keep the existing `queryCatalog` wrapper for focused tests by adapting its details map to summaries.

- [ ] **Step 4: Add OSS index version 2**

Write `catalog.json` as:

```ts
const CatalogObjectV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  revision: Schema.String,
  createdAt: SkillMarket.Timestamp,
  items: Schema.Array(
    Schema.Struct({
      summary: SkillMarket.Summary,
      detail: Schema.Struct({ key: Schema.String, sha256: SkillMarket.Sha256 }),
    }),
  ),
})
```

Detail keys must match `details/<sha256>.json`. `publishCatalogIndex` uploads only supplied changed detail objects, index, facets, then pointer. Validate index/facets plus changed references. Decode the old object when `schemaVersion` is absent and retain old revision-specific detail path resolution.

- [ ] **Step 5: Implement cached reads**

`createCatalogReader` caches pointer/index/facets for 60 seconds by revision and caches at most 512 decoded details using insertion-ordered LRU eviction. Export methods `list`, `facets`, `detail`, `versions`, and `download`. Validate a fetched detail body against the reference SHA-256 before Schema decoding.

Update both Effect HttpApi handlers and the legacy Web handler to consume this reader instead of `loadCurrentSnapshot`. Keep status codes, headers, CORS, ETag, and response bodies unchanged.

- [ ] **Step 6: Verify GREEN and scale bounds**

Run:

```bash
bun test test/catalog-reader.test.ts test/oss.test.ts test/http.test.ts test/performance.test.ts
bun typecheck
```

Expected: all tests pass; an 80,000-item list performs zero detail reads; one uncached detail performs one detail read.

- [ ] **Step 7: Commit**

```bash
git add src/catalog-reader.ts src/catalog.ts src/oss.ts src/handlers.ts src/http/catalog.ts src/server.ts test/catalog-reader.test.ts test/oss.test.ts test/http.test.ts test/performance.test.ts
git commit -m "refactor(skill-market): scale catalog storage"
```

---

### Task 7: Integrate Incremental Publication with Community and Enterprise Sources

**Files:**
- Modify: `packages/skill-market-server/src/publisher.ts`
- Modify: `packages/skill-market-server/src/community.ts`
- Modify: `packages/skill-market-server/src/sync.ts`
- Modify: `packages/skill-market-server/src/catalog.ts`
- Modify: `packages/skill-market-server/test/publisher.test.ts`
- Modify: `packages/skill-market-server/test/community.test.ts`
- Modify: `packages/skill-market-server/test/sync.test.ts`

**Interfaces:**
- Produces: threshold publication of mirrored SkillHub entries and legacy snapshot seeding.
- Consumes: `SkillHubImportStore.mirroredEntries/seedLegacy`, `CatalogIndex`, content-addressed community/enterprise details, and existing publisher leases.

- [ ] **Step 1: Write failing incremental publication tests**

Seed a version-1 snapshot with 19 entries, an empty import database, and one community publication job. Assert startup seeding records all 18 SkillHub entries without redownloading packages, community publication preserves them, and adding 2,000 mirrored rows produces a version-2 index. Assert long mirror network work occurs before `withCatalogLease` is acquired.

- [ ] **Step 2: Run the tests and verify RED**

Run: `bun test test/publisher.test.ts test/community.test.ts test/sync.test.ts` from `packages/skill-market-server`.

Expected: FAIL because publisher and sync still require full `CatalogSnapshot` detail maps.

- [ ] **Step 3: Make community and enterprise details content-addressed**

When community or enterprise materialization creates a `SkillMarket.Detail`, serialize and hash it, PUT `details/<sha256>.json`, and return `{ summary, detailRef }`. Preserve content-addressed package and icon behavior. Do not fetch all SkillHub details while publishing one community submission.

- [ ] **Step 4: Refactor publisher inputs**

Build a new index from the current summaries/references plus changed entries. `withCatalogLease` must cover only final index/facets writes and pointer movement. Keep publication job recovery, target revision persistence, and community submission state transitions unchanged.

- [ ] **Step 5: Seed legacy and schedule threshold publication**

On the first version-2 run, read the 19-entry legacy snapshot once, write content-addressed details, and call `seedLegacy`. Publish when `mirrored - lastPublishedCount >= 2_000`, 30 minutes have elapsed, or a generation completes. During import set SkillHub status to `stale`; set it to `fresh` only when discovery is stable and no item remains pending/running/retry_wait.

Remove the old whole-source `loadSkillHub` refresh path that runs every ten minutes. Keep enterprise conditional ETag and community reads.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
bun test test/publisher.test.ts test/community.test.ts test/sync.test.ts
bun typecheck
```

Expected: all tests pass; community publication does not trigger O(N) SkillHub detail reads or writes.

- [ ] **Step 7: Commit**

```bash
git add src/publisher.ts src/community.ts src/sync.ts src/catalog.ts test/publisher.test.ts test/community.test.ts test/sync.test.ts
git commit -m "feat(skill-market): publish mirrored batches"
```

---

### Task 8: Add Audited Admin Progress and Commands

**Files:**
- Create: `packages/skill-market-server/src/skillhub-import-admin.ts`
- Create: `packages/skill-market-server/test/skillhub-import-admin.test.ts`
- Modify: `packages/skill-market-server/src/http/admin.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Modify: `packages/skill-market-server/test/control-http.test.ts`

**Interfaces:**
- Produces: `createSkillHubImportAdmin({ database, security, imports })` with `status(principal)` and `command(principal, input)`.
- Consumes: admin security, import store progress/commands, audit events, generated HttpApi handlers.

- [ ] **Step 1: Write failing authorization and audit tests**

Assert reviewer-only and anonymous principals receive forbidden responses. For an admin, execute pause, resume, retry-wait, and retry-rejected, then assert returned progress and append-only audit actions:

```ts
expect(audit.map((event) => event.action)).toEqual([
  "skillhub-import-paused",
  "skillhub-import-resumed",
  "skillhub-import-retried",
  "skillhub-import-retried",
])
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test test/skillhub-import-admin.test.ts test/control-http.test.ts` from `packages/skill-market-server`.

Expected: FAIL because the admin service and handlers do not exist.

- [ ] **Step 3: Implement the admin service**

Require `security.requireAdmin(principal)` for both methods. Decode command input with Effect Schema. Update generation/item states transactionally and insert an audit event with `object_type = 'skillhub_import'`, the active generation ID, before/after counts, request ID, and actor employee ID. Retrying rejected items must preserve prior error information inside the audit payload before clearing queue error columns.

- [ ] **Step 4: Wire HttpApi handlers**

Add the two generated operation handlers to `createAdminHttp`, pass the service through `MarketHttpOptions`, and map invalid commands to `SkillMarketInvalidRequest`. Call the SkillHub worker wake callback after resume or retry commands.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
bun test test/skillhub-import-admin.test.ts test/control-http.test.ts test/security.test.ts
bun typecheck
```

Expected: all tests pass and non-admin access remains forbidden.

- [ ] **Step 6: Commit**

```bash
git add src/skillhub-import-admin.ts src/http/admin.ts src/handlers.ts src/server.ts test/skillhub-import-admin.test.ts test/control-http.test.ts
git commit -m "feat(skill-market): administer SkillHub imports"
```

---

### Task 9: Show Import Progress in the Web Admin

**Files:**
- Create: `packages/skill-market-web/src/admin/skillhub.tsx`
- Create: `packages/skill-market-web/src/admin/skillhub.test.tsx`
- Modify: `packages/skill-market-web/src/control-data-source.ts`
- Modify: `packages/skill-market-web/src/control-data-source.test.ts`
- Modify: `packages/skill-market-web/src/app.tsx`
- Modify: `packages/skill-market-web/src/shell.tsx`
- Modify: `packages/skill-market-web/src/styles.css`
- Modify: `packages/skill-market-web/script/release.ts`
- Modify: `packages/skill-market-web/script/release.test.ts`
- Modify: `packages/skill-market-web/e2e/market.e2e.ts`
- Modify: `packages/skill-market-web/e2e/fixtures/server.ts`

**Interfaces:**
- Produces: `/admin/skillhub` route with progress polling and pause/resume/retry controls.
- Consumes: `SkillMarketControlDataSource.skillhub.status/command`, existing admin session shell, TanStack Query, and generated control schemas.

- [ ] **Step 1: Write failing component and data-source tests**

Render the page with progress `mirrored: 20_000`, `upstreamTotal: 78_253`, `state: running`; assert visible progress, uploaded size, rate, ETA, and a pause button. Click pause and assert `{ command: "pause" }`. For paused state assert resume. For nonzero retry/rejected counts assert separate retry buttons. Add data-source tests for exact GET/POST paths and CSRF/idempotency headers.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test src/admin/skillhub.test.tsx src/control-data-source.test.ts script/release.test.ts` from `packages/skill-market-web`.

Expected: FAIL because the route, component, and source methods are absent.

- [ ] **Step 3: Extend the control data source**

Add:

```ts
skillhub: {
  status: (signal?: AbortSignal) =>
    read("/v1/admin/skillhub-import", SkillMarketControl.SkillHubImportProgress, signal),
  command: (input: SkillMarketControl.SkillHubImportCommandInput, signal?: AbortSignal) =>
    write("/v1/admin/skillhub-import/command", SkillMarketControl.SkillHubImportProgress, input, signal),
},
```

- [ ] **Step 4: Implement the admin page**

Use a 5-second polling query while state is running and a 30-second interval otherwise. Display a labeled progress bar using `mirrored + rejected` over `upstreamTotal`; cards for discovered, mirrored, retry, rejected, uploaded bytes, rate, and ETA; current page/sweep/concurrency below the cards. Require confirmation before retrying rejected items. Disable controls while their mutation is pending and show the existing inline error presentation on failure.

Add the route to `app.tsx`, an admin-only shell link labeled `SkillHub 同步`, and `/admin/skillhub` to release fallback paths.

- [ ] **Step 5: Add browser coverage**

Extend the fixture server with progress/command endpoints and add a Playwright test that signs in as admin, opens `/admin/skillhub`, pauses, resumes, and confirms the displayed state changes without a full-page reload.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
bun test src/admin/skillhub.test.tsx src/control-data-source.test.ts src/shell.test.tsx script/release.test.ts
bun typecheck
bunx playwright test e2e/market.e2e.ts
```

Expected: unit, type, release, and browser tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/admin/skillhub.tsx src/admin/skillhub.test.tsx src/control-data-source.ts src/control-data-source.test.ts src/app.tsx src/shell.tsx src/styles.css script/release.ts script/release.test.ts e2e/market.e2e.ts e2e/fixtures/server.ts
git commit -m "feat(skill-market): show import progress"
```

---

### Task 10: Package the Worker and Deployment Units

**Files:**
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-skillhub.service`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-skillhub.timer`
- Modify: `packages/skill-market-server/deploy/systemd.test.ts`
- Modify: `packages/skill-market-server/deploy/ruying-skill-market.env.example`
- Modify: `packages/skill-market-server/deploy/README.md`
- Modify: `packages/skill-market-server/README.md`
- Modify: `packages/skill-market-server/script/build-release.ts`
- Modify: `packages/skill-market-server/script/build-release.test.ts`
- Modify: `packages/skill-market-server/script/deploy-check.ts`
- Modify: `packages/skill-market-server/script/deploy-check.test.ts`

**Interfaces:**
- Produces: immutable release containing `skillhub-worker`, a one-minute systemd timer, and preflight checks for queue configuration.
- Consumes: existing `ruying-market` user, `/run/lock`, database paths, release symlink, and environment file.

- [ ] **Step 1: Write failing release and systemd tests**

Assert release output contains `runtime/src/skillhub-worker.js`, service uses `/usr/local/bin/bun src/skillhub-worker.ts`, the timer uses `OnUnitActiveSec=1min`, and the service has the same hardening plus `ReadWritePaths` as the current sync service. Assert it uses `/run/lock/ruying-skill-market-skillhub.lock`, not the community publication lock.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test script/build-release.test.ts deploy/systemd.test.ts script/deploy-check.test.ts` from `packages/skill-market-server`.

Expected: FAIL because the worker entrypoint and units are not packaged.

- [ ] **Step 3: Add release and systemd wiring**

Add `src/skillhub-worker.ts` to `build-release.ts`. The service must be a `Type=oneshot` unit using the `ruying-market` account, environment file, current release working directory, separate flock, strict hardening, and writable database/backup/lock paths. The timer must be persistent, start two minutes after boot, run every minute, and add up to 10 seconds randomized delay.

- [ ] **Step 4: Document and preflight configuration**

Add all six concurrency/publication/memory environment variables with design defaults to the example and README. Keep `SKILL_MARKET_SKILLHUB_LIMIT=30` documented only as an emergency canary override; production full mirror omits it. Extend preflight output with non-secret numeric configuration and confirm database/backup directories are writable.

- [ ] **Step 5: Verify GREEN and build an immutable release**

Run:

```bash
bun test script/build-release.test.ts deploy/systemd.test.ts script/deploy-check.test.ts
bun typecheck
bun run build:release
```

Expected: all tests pass and the release contains server, sync, existing worker, SkillHub worker, migrations, scripts, and systemd units.

- [ ] **Step 6: Commit**

```bash
git add deploy/systemd/ruying-skill-market-skillhub.service deploy/systemd/ruying-skill-market-skillhub.timer deploy/systemd.test.ts deploy/ruying-skill-market.env.example deploy/README.md README.md script/build-release.ts script/build-release.test.ts script/deploy-check.ts script/deploy-check.test.ts
git commit -m "chore(skill-market): deploy mirror worker"
```

---

### Task 11: Run Full Regression, Performance, and Production Canary

**Files:**
- Modify only if verification exposes a defect: files already named in Tasks 1-10.

**Interfaces:**
- Consumes: every deliverable above.
- Produces: verified release, 100-item production canary, and automatically resumed full import.

- [ ] **Step 1: Run package regressions**

Run from each package directory:

```bash
cd packages/schema && bun typecheck
cd ../protocol && bun test && bun typecheck
cd ../client && bun typecheck
cd ../skill-market-server && bun test && bun typecheck
cd ../skill-market-web && bun test && bun typecheck && bunx playwright test
```

Expected: every command exits 0 with no unexpected warning or skipped required suite.

- [ ] **Step 2: Run the 80,000-item performance test separately**

Run: `bun test test/performance.test.ts --timeout 120000` from `packages/skill-market-server`.

Expected: zero detail reads for a list request, one read for one uncached detail, bounded page concurrency, and delta-only detail publication.

- [ ] **Step 3: Review the complete diff**

Run:

```bash
git diff --check origin/dev...HEAD
git diff --stat origin/dev...HEAD
git status --short
```

Expected: no whitespace errors, no generated files edited by hand, no secrets, and only the user-owned `.superpowers/brainstorm/` remains untracked.

- [ ] **Step 4: Build and deploy the release**

Build `packages/skill-market-server/dist/release`, transfer it to `root@10.246.13.226` over port 9922, install it under `/srv/ruying-skill-market/releases/$(git rev-parse HEAD)`, run the migration command as `ruying-market`, switch `/srv/ruying-skill-market/current` atomically, install/reload the two SkillHub systemd units, and restart the API. Do not print `/etc/ruying-skill-market/market.env` or any OSS credentials.

- [ ] **Step 5: Run a 100-item canary**

Set `SKILL_MARKET_SKILLHUB_LIMIT=100`, start the SkillHub worker timer, and verify via the admin progress endpoint that discovery, normalization, package mirroring, content-addressed details, and incremental publication succeed. Sample at least one repaired-name package, one manifest-rebuilt package, and one unchanged valid package; download each through the public API and verify declared size and SHA-256.

- [ ] **Step 6: Start the full import**

Remove `SKILL_MARKET_SKILLHUB_LIMIT`, restart only the SkillHub timer/service so it rereads configuration, and verify progress begins increasing beyond 100 while API list, detail, submissions, review queue, and role administration remain healthy.

- [ ] **Step 7: Verify rollback readiness**

Record the prior and current catalog revisions, confirm the database backup passes `PRAGMA integrity_check`, pause/resume once from the admin panel, and verify restoring the previous `current.json` pointer does not require deleting immutable package/detail objects. Return the pointer to the new revision after the drill.

- [ ] **Step 8: Commit verification-only fixes if needed**

If Steps 1-7 require code changes, rerun the affected RED/GREEN test cycle and commit them with:

```bash
git add -p
git commit -m "fix(skill-market): complete mirror rollout"
```

If no files changed, do not create an empty commit.

---

### Task 11 verification report (2026-07-17)

- Fixed post-review canary behavior: `SKILL_MARKET_SKILLHUB_LIMIT` now bounds the effective discovery total and enqueued records. A refresh of a completed generation probes only page 1 and creates a new generation only when the effective total changes; equal full or limited totals are no-ops, while an expanded or reduced upstream total starts a new sweep. Generic completed discovery remains a zero-network no-op.
- Publication checkpoints are now written only after a successful catalog pointer publish. The 30-minute trigger falls back to the active generation start time before the first publication.
- Permanent SkillHub metadata errors (including 404, schema, redirect, and other non-transient failures) now reject the affected upstream item; transport, 429, and 5xx errors remain retryable. A completed discovery generation converges after a 404 rejection.
- Permanent optional-icon failures (disallowed host, 404, and unsupported MIME) omit the icon but mirror the verified package. Temporary download and storage failures remain retryable, and package/archive/malware rejection paths are unchanged.
- Verified locally: Schema typecheck; Protocol tests and typecheck; Client typecheck; Skill Market Server 204 tests, typecheck, and the separate 80,000-item performance test; Skill Market Web 63 unit/browser tests, typecheck, and 20 Playwright passes (10 intentionally skipped). The Web package requires its `bun run test` script because UI tests require its browser preloads.
- Production deployment, 100-item Canary, full-import activation, and rollback drill require the production host and credentials, so they were not performed from this local worktree.

## Final Acceptance Checklist

- [ ] Stable discovery count matches SkillHub's enumerable total after a no-new-slug sweep.
- [ ] Every item is `mirrored` or has a bounded hard-rejection reason.
- [ ] Existing Web and desktop catalog calls remain compatible.
- [ ] Lists do not fetch all detail objects; details fetch at most one uncached object.
- [ ] Package and detail uploads are content-addressed and idempotent.
- [ ] Restart, 429, OSS error, and expired lease tests prove resumability.
- [ ] Admin progress and all four commands are authorized, audited, and usable.
- [ ] Community submission publishing remains responsive during the full mirror.
- [ ] The live canary succeeds before the 30-record limit is finally removed.
