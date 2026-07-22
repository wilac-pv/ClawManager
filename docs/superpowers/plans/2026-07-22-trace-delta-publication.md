# TRACE Delta Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish completed TRACE scores by patching at most 100 entries in the current catalog, without decoding the entire SQLite SkillHub mirror or exceeding the production worker budget.

**Architecture:** Add a memory-conscious catalog patch primitive, then add an evaluation-only publisher path that revalidates the selected rows under the durable catalog lease and changes only those entries. Keep full SkillHub mirror publication unchanged. Retire pre-target delta lease jobs instead of queueing a generic full rebuild, and enforce cgroup/time limits as defense in depth.

**Tech Stack:** Bun, TypeScript, Bun SQLite, Effect Schema, AWS S3-compatible object storage, systemd, Bun test.

## Global Constraints

- Evaluation delta publication must never call `SkillHubImportStore.mirroredEntries()`.
- A batch contains at most `100` completed evaluations.
- Revalidate slug, `evaluation_checked_at`, and previous detail SHA-256 while the catalog lease is held.
- Preserve unrelated catalog summaries, detail references, aliases, featured state, source status, and immutable package metadata.
- Force evaluated SkillHub details and summaries to public `score: 0`.
- Keep pointer publication atomic and preserve ambiguous-pointer expiry recovery.
- Pre-target evaluation-delta failure must not leave a claimable generic catalog rebuild job.
- Production service limits are `MemoryHigh=768M`, `MemoryMax=1024M`, `TimeoutStartSec=65s`, and `TimeoutStopSec=10s`.
- The 80,000-entry scale fixture must finish inside 45 seconds with peak RSS below 1 GiB.
- Keep evaluation and general publisher timers disabled until production verification passes.

---

### Task 1: Add a memory-conscious catalog patch primitive

**Files:**
- Modify: `packages/skill-market-server/src/catalog.ts`
- Modify: `packages/skill-market-server/test/catalog.test.ts`
- Create: `packages/skill-market-server/test/catalog-scale-fixture.ts`
- Create: `packages/skill-market-server/test/catalog-scale.test.ts`

**Interfaces:**
- Consumes: `CatalogIndex`, `CatalogDetail`, `key(source, id)`.
- Produces: `patchCatalogIndex(input: { index: CatalogIndex; replacements: ReadonlyMap<string, Pick<CatalogDetail, "summary" | "ref">>; sourceStatus: SkillMarket.SourceStatus; createdAt?: string }): CatalogIndex`.
- Produces: revision hashing compatible with the existing `JSON.stringify({ entries, sourceStatus })` definition without allocating one full `entries` JSON string.

- [ ] **Step 1: Write compatibility and preservation tests**

Add tests that build a mixed catalog, replace two SkillHub entries, and assert:

```ts
const patched = patchCatalogIndex({
  index,
  replacements: new Map([[key("skillhub", "a"), replacement]]),
  sourceStatus: { ...index.sourceStatus, skillhub: "fresh" },
  createdAt: "2026-07-22T00:00:00.000Z",
})

expect(patched.items.find((item) => item.id === "a")).toEqual(replacement.summary)
expect(patched.details.get(key("skillhub", "a"))).toEqual(replacement.ref)
expect(patched.items.find((item) => item.id === "community-a")).toEqual(
  index.items.find((item) => item.id === "community-a"),
)
expect(patched.details.get(key("community", "community-a"))).toEqual(
  index.details.get(key("community", "community-a")),
)
```

Also calculate the legacy revision in the test with:

```ts
const entries = patched.items.map((summary) => [
  key(summary.source, summary.id),
  { summary, ref: patched.details.get(key(summary.source, summary.id))! },
])
const legacyRevision = new Bun.CryptoHasher("sha256")
  .update(JSON.stringify({ entries, sourceStatus: patched.sourceStatus }))
  .digest("hex")
expect(patched.revision).toBe(legacyRevision)
```

- [ ] **Step 2: Run the focused test to verify RED**

Run from `packages/skill-market-server`:

```bash
bun test test/catalog.test.ts
```

Expected: FAIL because `patchCatalogIndex` is not exported.

- [ ] **Step 3: Implement streaming-compatible revision hashing and single-pass facets**

Implement a shared revision helper that emits the same JSON token sequence as the old whole-object `JSON.stringify`:

```ts
function revisionForEntries(
  entries: ReadonlyArray<readonly [string, Pick<CatalogDetail, "summary" | "ref">]>,
  sourceStatus: SkillMarket.SourceStatus,
) {
  const hash = new Bun.CryptoHasher("sha256").update('{"entries":[')
  entries.forEach((entry, index) => {
    if (index > 0) hash.update(",")
    hash.update(JSON.stringify(entry))
  })
  return hash.update(`],"sourceStatus":${JSON.stringify(sourceStatus)}}`).digest("hex")
}
```

Use it from both `createCatalogIndex` and `patchCatalogIndex`. Refactor facet construction to skip delisted entries during one pass instead of allocating `items.filter(...)`. `patchCatalogIndex` must reject a replacement whose key is absent or whose summary key differs from the replacement map key.

- [ ] **Step 4: Add the 80,000-entry subprocess scale test**

The fixture must create 80,000 compact valid summaries/references, patch 100 entries, and print one JSON record:

```ts
console.log(JSON.stringify({
  elapsedMilliseconds: performance.now() - started,
  maxRssKilobytes: process.resourceUsage().maxRSS,
  items: patched.items.length,
}))
```

The parent test spawns a fresh Bun process with a 45-second timeout and asserts:

```ts
expect(result.exitCode).toBe(0)
expect(metrics.items).toBe(80_000)
expect(metrics.elapsedMilliseconds).toBeLessThan(45_000)
expect(metrics.maxRssKilobytes).toBeLessThan(1024 * 1024)
```

- [ ] **Step 5: Run catalog tests and typecheck**

```bash
bun test test/catalog.test.ts test/catalog-scale.test.ts
bun typecheck
git diff --check
```

Expected: all pass; scale output is below 1 GiB and 45 seconds.

- [ ] **Step 6: Commit**

```bash
git add packages/skill-market-server/src/catalog.ts packages/skill-market-server/test/catalog.test.ts packages/skill-market-server/test/catalog-scale-fixture.ts packages/skill-market-server/test/catalog-scale.test.ts
git commit -m "perf(skill-market): patch catalog entries"
```

---

### Task 2: Publish completed TRACE results through the delta path

**Files:**
- Modify: `packages/skill-market-server/src/publisher.ts`
- Modify: `packages/skill-market-server/src/skillhub-evaluation-worker.ts`
- Modify: `packages/skill-market-server/test/publisher.test.ts`
- Modify: `packages/skill-market-server/test/skillhub-evaluation-worker.test.ts`

**Interfaces:**
- Consumes: `patchCatalogIndex`, `SkillHubImportStore.completedEvaluations(limit)`, `SkillHubImportStore.replaceCompletedEvaluationDetails(entries)`.
- Produces: `Publisher.publishCompletedSkillHubEvaluations(imports, workerID, evaluationLimit, signal)`.
- Keeps: `Publisher.publishMirroredSkillHub(...)` for full mirror reconciliation.

- [ ] **Step 1: Write failing delta-path tests**

Create an import-store test double whose `mirroredEntries()` throws and verify evaluation publication still succeeds:

```ts
const imports = {
  ...evaluationImports(fixture, completed),
  mirroredEntries() {
    throw new Error("full mirror decode is forbidden for TRACE delta publication")
  },
}
await publisher.publishCompletedSkillHubEvaluations(imports, "worker-trace", 100)
```

Assert an unrelated SkillHub item, community item, enterprise item, detail ref,
alias, and featured flag are unchanged. Assert the evaluated detail and summary
contain `score: 0`, `evaluationScore: 4.45`, and all five TRACE dimensions.

- [ ] **Step 2: Write failing in-lease revalidation tests**

Make the first `completedEvaluations()` return a materializable result and the
second call return either a changed checked time or changed previous detail hash.
Assert the stale entry is not placed in the pointer index and
`replaceCompletedEvaluationDetails` receives no stale entry.

- [ ] **Step 3: Write failing pre-target retirement test**

Reject the catalog object write before `persistTarget()` and assert:

```ts
expect(fixture.database.read((db) =>
  db.query<{ count: number }, []>(
    "SELECT count(*) AS count FROM publish_jobs WHERE kind = 'catalog_rebuild' AND status = 'pending'",
  ).get()!.count,
)).toBe(0)
expect(imports.completedEvaluations(100)).toHaveLength(1)
```

Keep the existing test proving an aborted, transport-ambiguous pointer write
retains a running lease for expiry recovery.

- [ ] **Step 4: Run focused tests to verify RED**

```bash
bun test test/publisher.test.ts test/skillhub-evaluation-worker.test.ts
```

Expected: FAIL because the delta publisher method does not exist and the worker
still calls `publishMirroredSkillHub`.

- [ ] **Step 5: Implement the delta publisher**

Materialize the initial bounded candidates, then acquire the catalog lease. Under
the lease, call `completedEvaluations(evaluationLimit)` again and retain only
exact `(slug, checkedAt, previousDetailSha256)` matches. Load the latest index
once and call:

```ts
const replacements = new Map(
  evaluated.map((value) => [
    key(value.entry.summary.source, value.entry.summary.id),
    { summary: value.entry.summary, ref: {
      key: normalizeMirrorDetailKey(value.entry.detailKey, value.entry.detailSha256, this.options.ossPrefix),
      sha256: value.entry.detailSha256,
      version: value.entry.summary.version,
    } },
  ]),
)
const index = patchCatalogIndex({
  index: latest,
  replacements,
  sourceStatus: { ...latest.sourceStatus, skillhub: imports.progress().sourceStatus },
})
```

Publish only evaluated details as `changedDetails`, then apply the existing
post-pointer CAS markers.

- [ ] **Step 6: Retire pre-target delta lease jobs**

Extend the catalog lease helper with an explicit failure policy used only by the
delta method. Before a target exists, set its job to `failed`, clear lease fields,
and store a bounded generic error code/summary. Do not expose exception bodies.
After a target exists, keep the current pointer-check and ambiguous-abort rules.

- [ ] **Step 7: Wire the evaluation worker to the delta method**

Change only `evaluationPublication(...)`:

```ts
publish: (request) =>
  publisher.publishCompletedSkillHubEvaluations(imports, workerID, batch, request.signal).then(() => undefined),
```

- [ ] **Step 8: Run publisher, fencing, and worker tests**

```bash
bun test test/publisher.test.ts test/skillhub-import-store.test.ts test/skillhub-evaluation-worker.test.ts test/skillhub-worker.test.ts test/worker.test.ts test/oss.test.ts
bun typecheck
git diff --check
```

Expected: all pass; full mirror tests continue to exercise
`publishMirroredSkillHub`, while evaluation tests exercise only the delta method.

- [ ] **Step 9: Commit**

```bash
git add packages/skill-market-server/src/publisher.ts packages/skill-market-server/src/skillhub-evaluation-worker.ts packages/skill-market-server/test/publisher.test.ts packages/skill-market-server/test/skillhub-evaluation-worker.test.ts
git commit -m "fix(skill-market): publish trace deltas"
```

---

### Task 3: Add production resource safeguards and release verification

**Files:**
- Modify: `packages/skill-market-server/deploy/systemd/ruying-skill-market-evaluation.service`
- Modify: `packages/skill-market-server/deploy/systemd.test.ts`
- Modify: `packages/skill-market-server/deploy/README.md`
- Modify: `packages/skill-market-server/README.md`
- Modify: `packages/skill-market-server/script/build-release.test.ts`

**Interfaces:**
- Consumes: the delta worker entrypoint from Task 2.
- Produces: a release unit bounded by `MemoryHigh=768M`, `MemoryMax=1024M`, `TimeoutStartSec=65s`, and `TimeoutStopSec=10s`.

- [ ] **Step 1: Write failing systemd assertions**

Add exact unit tests:

```ts
expect(service).toContain("MemoryHigh=768M")
expect(service).toContain("MemoryMax=1024M")
expect(service).toContain("TimeoutStartSec=65s")
expect(service).toContain("TimeoutStopSec=10s")
```

Keep the existing assertions for the dedicated flock, `ruying-market` identity,
write paths, and hardening.

- [ ] **Step 2: Run systemd tests to verify RED**

```bash
bun test deploy/systemd.test.ts
```

Expected: FAIL because the deployed unit still has `MemoryMax=1536M` and no
high-memory or start/stop timeout controls.

- [ ] **Step 3: Update unit and operational documentation**

Set the four exact resource directives. Document that a systemd timeout before a
target revision leaves completed evaluations retryable, while a target-bearing
lease is handled by expiry recovery. Document that evaluation and publisher
timers remain disabled after an abnormal memory/IO event until a manual bounded
run passes.

- [ ] **Step 4: Run full server verification and build release**

```bash
bun test
bun typecheck
bun run build:release /tmp/ruying-skill-market-trace-delta-release
test -s /tmp/ruying-skill-market-trace-delta-release/packages/skill-market-server/src/skillhub-evaluation-worker.js
git diff --check
```

Expected: the full server suite passes and the release contains the updated unit
and evaluation worker.

- [ ] **Step 5: Commit**

```bash
git add packages/skill-market-server/deploy packages/skill-market-server/README.md packages/skill-market-server/script/build-release.test.ts
git commit -m "chore(skill-market): bound trace publication"
```

---

### Task 4: Deploy and verify the production delta publisher

**Files:**
- No source files; record evidence in `.superpowers/sdd/trace-delta-production-report.md`.

**Interfaces:**
- Consumes: the reviewed committed release from Tasks 1–3.
- Produces: a healthy production API with the general publisher and evaluation timers restored.

- [ ] **Step 1: Run final local verification from package directories**

```bash
cd packages/schema && bun typecheck
cd ../protocol && bun test && bun typecheck
cd ../skill-market-server && bun test && bun typecheck
cd ../app && bun test src/skill-market && bun typecheck
cd ../skill-market-web && bun run test && bun typecheck && bun run build
```

Expected: all pass. Record exact counts and artifact SHA-256 values in the
production report.

- [ ] **Step 2: Build and transfer an immutable API release**

```bash
release_commit=$(git rev-parse HEAD)
release_output="/tmp/ruying-skill-market-${release_commit}"
cd packages/skill-market-server
bun run build:release "$release_output"
```

Add a `RELEASE.json` containing the exact commit and UTC build time, transfer to
`root@10.246.13.226` on SSH port `9922`, verify the worker and unit hashes, and
install root-owned mode `0755` at `/srv/ruying-skill-market/releases/$release_commit`.

- [ ] **Step 3: Quiesce, back up, and switch the API**

Keep both `ruying-skill-market-evaluation.timer` and
`ruying-skill-market-worker.timer` stopped. Stop the API, run the existing backup
service, require SQLite integrity `ok` and zero foreign-key violations, atomically
switch `/srv/ruying-skill-market/current`, run migrations, install the updated
evaluation unit, and start the API. Roll back the symlink if health does not
return within 20 seconds.

- [ ] **Step 4: Retire the known incident job**

After the backup and before restoring publisher work, verify this exact row has
`kind='catalog_rebuild'`, `status='pending'`, and `target_revision IS NULL`:

```text
job_V14-kst8tZWgI_4lML1kOJGJzj0IMwNQF2qPGfYuR5o
```

Update only that ID to `status='failed'`, clear lease fields, and store the generic
reason `trace-delta-pretarget-memory-guard`. Abort deployment if the row no longer
matches the expected state.

- [ ] **Step 5: Run one bounded evaluation publication while sampling resources**

Start `ruying-skill-market-evaluation.service` manually with its timer still
disabled. Sample every second:

```bash
systemctl show ruying-skill-market-evaluation.service -p MemoryCurrent -p MemoryPeak -p ActiveState
vmstat 1 2
```

Require service success within 65 seconds, `MemoryPeak < 1073741824`, no sustained
IO wait above 10%, and no increase in used swap after the run. Require no pending
or running target-less catalog job.

- [ ] **Step 6: Verify the sample API and Web**

```bash
curl -fsS http://127.0.0.1:4210/v1/catalog/skills/skillhub/ai-intelligence-investigator
curl -fsS http://127.0.0.1:4211/ai-coding/ruying-code/skill-market/skills/skillhub/ai-intelligence-investigator
```

Decode the API response and require `score === 0`, `evaluationScore === 4.45`,
all five TRACE dimensions, and an ISO `evaluatedAt`. Require the Web build to
render `4.5/5` and never `100000.0`.

- [ ] **Step 7: Restore timers and observe two runs**

Start and enable `ruying-skill-market-worker.timer`, then start and enable
`ruying-skill-market-evaluation.timer`. Observe two evaluation timer runs and
require successful journal count records, increasing completed progress, memory
below the hard limit, low IO wait, and healthy API/SkillHub mirror services.

- [ ] **Step 8: Record production evidence**

Write `.superpowers/sdd/trace-delta-production-report.md` with deployed commit,
release paths, backup identity, migration version, sample score, before/after queue
counts, service results, peak memory, swap delta, IO observations, timer status,
and rollback release. Do not record environment values or credentials.
