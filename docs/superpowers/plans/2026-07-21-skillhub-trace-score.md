# SkillHub TRACE Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop displaying SkillHub ranking weights as ratings, persist real TRACE evaluations, backfill every mirrored Skill at a safe rate, and expose independent progress.

**Architecture:** Keep the upstream list `score` as a private ranking input during one compatibility release and add an optional public `evaluationScore` plus TRACE dimensions. A durable SQLite queue claims mirrored rows, fetches `/api/v1/skills/{slug}/evaluation`, rewrites content-addressed detail objects, and republishes the catalog in bounded batches. The UI reads only `evaluationScore`, so `100000.0` disappears before backfill completes.

**Tech Stack:** TypeScript, Bun, Effect Schema, SQLite, SolidJS, TanStack Solid Query, S3-compatible OSS, systemd.

## Global Constraints

- TRACE scores are `0–5`; all five dimensions are required and each dimension must contain at least one finite item score.
- Upstream ranking weights must never be displayed as ratings.
- Default evaluation concurrency is `2`, request rate is at most `60` per minute, and successful results refresh after `7` days.
- Missing evaluations display `待评分` for SkillHub and `未评分` for enterprise/community records.
- The existing SkillHub mirror must continue while evaluation failures remain isolated to the evaluation queue.
- Run tests and `bun typecheck` only from package directories, never from the repository root.
- After changing public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`; never edit generated clients directly.

---

## File Structure

- `packages/schema/src/skill-market.ts`: public optional TRACE score and five-dimension contract.
- `packages/schema/src/skill-market-control.ts`: evaluation progress contract for administrators.
- `packages/skill-market-server/migrations/005_skillhub_evaluations.sql`: durable evaluation state, leases, retry fields, scores, and queue index.
- `packages/skill-market-server/src/skillhub-evaluation.ts`: upstream response validation and TRACE calculation.
- `packages/skill-market-server/src/skillhub-evaluation-store.ts`: claim, renew, complete, retry, refresh, and progress transactions.
- `packages/skill-market-server/src/skillhub-evaluation-worker.ts`: bounded fetch/store/publication entrypoint.
- `packages/skill-market-server/src/skillhub-mirror.ts`: new mirrors publish no fake rating and enqueue evaluation after mirroring.
- `packages/skill-market-server/src/publisher.ts`: publish evaluated SkillHub entries without racing catalog publication.
- `packages/skill-market-server/src/config.ts`: evaluation concurrency, rate, refresh, and publication settings.
- `packages/protocol/src/groups/skill-market-admin.ts`: authenticated evaluation progress endpoint.
- `packages/skill-market-server/src/skillhub-import-admin.ts`: admin progress read.
- `packages/skill-market-server/src/http/admin.ts`, `src/server.ts`, `src/handlers.ts`: endpoint wiring.
- `packages/app/src/skill-market/list.tsx`, `detail.tsx`: safe score labels that never read the legacy ranking field.
- `packages/skill-market-web/src/admin/skillhub.tsx`, `control-data-source.ts`: independent TRACE progress panel.
- `packages/skill-market-server/deploy/systemd/ruying-skill-market-evaluation.{service,timer}`: recurring isolated worker.
- Release, deployment, README, and tests adjacent to the files above.

### Task 1: Add the public TRACE contract and safe UI labels

**Files:**
- Modify: `packages/schema/src/skill-market.ts`
- Modify: `packages/app/src/skill-market/list.tsx`
- Modify: `packages/app/src/skill-market/detail.tsx`
- Modify: `packages/app/src/skill-market/list.test.tsx`
- Modify: `packages/app/src/skill-market/detail.test.tsx`

**Interfaces:**
- Produces: `SkillMarket.EvaluationScore`, `SkillMarket.TraceEvaluation`, and optional `evaluationScore` / `traceEvaluation` fields on `Summary` and `Detail`.
- Compatibility: existing `score` remains readable for one release but no UI code may render it.

- [ ] **Step 1: Write failing schema and UI tests**

Add fixtures with `score: 100000` and no `evaluationScore`, then assert the card and detail display `待评分` rather than `100000.0`. Add a fixture with `evaluationScore: 4.45` and assert both surfaces display `4.5/5`. Add a community fixture without evaluation and assert `未评分`.

```tsx
expect(view.getByText("评分 待评分")).toBeTruthy()
expect(view.queryByText(/100000/)).toBeNull()
expect(scored.getByText("评分 4.5/5")).toBeTruthy()
expect(community.getByText("评分 未评分")).toBeTruthy()
```

- [ ] **Step 2: Run tests to verify failure**

Run from `packages/app`:

```bash
bun test src/skill-market/list.test.tsx src/skill-market/detail.test.tsx
```

Expected: FAIL because the schema lacks `evaluationScore` and the UI still calls `score.toFixed(1)`.

- [ ] **Step 3: Add the contract and one shared formatter**

Add this schema shape in `skill-market.ts` and add `scoreLabel(summary)` close to its two callers rather than duplicating formatting:

```ts
export const EvaluationScore = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(5),
)

export const TraceEvaluation = Schema.Struct({
  trust: EvaluationScore,
  reliability: EvaluationScore,
  adaptability: EvaluationScore,
  convention: EvaluationScore,
  effectiveness: EvaluationScore,
  evaluatedAt: Timestamp,
})

// Add to Summary; Detail inherits these fields.
evaluationScore: EvaluationScore.pipe(optional),
traceEvaluation: TraceEvaluation.pipe(optional),
```

```ts
function scoreLabel(record: SkillMarket.Summary) {
  if (record.evaluationScore !== undefined) return `${record.evaluationScore.toFixed(1)}/5`
  return record.source === "skillhub" ? "待评分" : "未评分"
}
```

Render `评分 {scoreLabel(props.item)}` and `{scoreLabel(record)}`. Do not use `record.score` in JSX.

- [ ] **Step 4: Run tests and typecheck**

```bash
bun test src/skill-market/list.test.tsx src/skill-market/detail.test.tsx
bun typecheck
```

Expected: PASS; no rendered text contains `100000`.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/skill-market.ts packages/app/src/skill-market/list.tsx packages/app/src/skill-market/detail.tsx packages/app/src/skill-market/list.test.tsx packages/app/src/skill-market/detail.test.tsx
git commit -m "fix(skill-market): hide ranking weights"
```

### Task 2: Add the durable evaluation queue migration

**Files:**
- Create: `packages/skill-market-server/migrations/005_skillhub_evaluations.sql`
- Modify: `packages/skill-market-server/test/database.test.ts`

**Interfaces:**
- Produces columns on `skillhub_import_items`: `evaluation_state`, attempts, retry, lease, five dimensions, overall score, timestamps, and error summary.
- Consumes: existing mirrored item state and `summary_json` from migration 004.

- [ ] **Step 1: Write the failing migration test**

Extend the current-version assertion to `5`. Seed a v4 mirrored row whose summary contains `"score":100000`, upgrade it, and assert:

```ts
expect(version).toBe(5)
expect(row.evaluation_state).toBe("pending")
expect(row.evaluation_score).toBeNull()
expect(JSON.parse(row.summary_json).evaluationScore).toBeUndefined()
```

Also assert non-mirrored rows have `evaluation_state = 'waiting'`.

- [ ] **Step 2: Run the database test to verify failure**

From `packages/skill-market-server`:

```bash
bun test test/database.test.ts
```

Expected: FAIL at version `4` and missing evaluation columns.

- [ ] **Step 3: Add migration 005**

Use SQLite `ALTER TABLE ... ADD COLUMN` statements with these exact invariants:

```sql
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_state TEXT NOT NULL DEFAULT 'waiting'
  CHECK (evaluation_state IN ('waiting', 'pending', 'running', 'retry_wait', 'completed', 'failed'));
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_attempts INTEGER NOT NULL DEFAULT 0 CHECK (evaluation_attempts >= 0);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_next_attempt_at INTEGER;
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_lease_owner TEXT;
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_lease_expires_at INTEGER;
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_trust REAL CHECK (evaluation_trust BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_reliability REAL CHECK (evaluation_reliability BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_adaptability REAL CHECK (evaluation_adaptability BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_convention REAL CHECK (evaluation_convention BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_effectiveness REAL CHECK (evaluation_effectiveness BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_score REAL CHECK (evaluation_score BETWEEN 0 AND 5);
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_checked_at INTEGER;
ALTER TABLE skillhub_import_items ADD COLUMN evaluation_error_summary TEXT CHECK (evaluation_error_summary IS NULL OR length(evaluation_error_summary) BETWEEN 1 AND 500);
UPDATE skillhub_import_items SET evaluation_state = 'pending' WHERE state = 'mirrored';
CREATE INDEX skillhub_evaluation_queue ON skillhub_import_items(evaluation_state, evaluation_next_attempt_at, evaluation_lease_expires_at, evaluation_checked_at, updated_at);
```

- [ ] **Step 4: Run migration tests**

```bash
bun test test/database.test.ts
```

Expected: PASS including upgrade, backup, rollback, and current-version cases.

- [ ] **Step 5: Commit**

```bash
git add migrations/005_skillhub_evaluations.sql test/database.test.ts
git commit -m "feat(skill-market): add evaluation queue"
```

### Task 3: Parse and calculate TRACE evaluations

**Files:**
- Create: `packages/skill-market-server/src/skillhub-evaluation.ts`
- Create: `packages/skill-market-server/test/skillhub-evaluation.test.ts`

**Interfaces:**
- Produces: `loadSkillHubEvaluation(fetcher, baseUrl, slug): Promise<SkillHubEvaluation>`.
- Produces: `SkillHubEvaluation` with all five dimension means plus `score`.

- [ ] **Step 1: Write failing calculation and validation tests**

Use a fixture shaped like the upstream response, with multiple item scores per dimension, and assert the sample overall is `4.45`. Add rejection cases for a missing dimension, empty items, `NaN`, values below `0`, values above `5`, non-2xx response, and malformed JSON.

```ts
expect(result).toEqual({
  trust: 5,
  reliability: 4,
  adaptability: 4.3,
  convention: 4.325,
  effectiveness: 4.625,
  score: 4.45,
})
```

- [ ] **Step 2: Run the test to verify failure**

```bash
bun test test/skillhub-evaluation.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict parsing and calculation**

Define the five names once and calculate each mean only after validating every item score:

```ts
const dimensions = ["trust", "reliability", "adaptability", "convention", "effectiveness"] as const

export type SkillHubEvaluation = Record<(typeof dimensions)[number], number> & { readonly score: number }

const mean = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0) / values.length
```

Build the URL using `new URL(`/api/v1/skills/${encodeURIComponent(slug)}/evaluation`, baseUrl)`, request JSON, require all five dimension arrays, require at least one valid item per dimension, compute the overall mean, and throw a typed upstream error without including response bodies.

- [ ] **Step 4: Run tests**

```bash
bun test test/skillhub-evaluation.test.ts
```

Expected: PASS for the 4.45 fixture and all malformed inputs.

- [ ] **Step 5: Commit**

```bash
git add src/skillhub-evaluation.ts test/skillhub-evaluation.test.ts
git commit -m "feat(skill-market): parse trace evaluations"
```

### Task 4: Implement lease-safe evaluation storage

**Files:**
- Create: `packages/skill-market-server/src/skillhub-evaluation-store.ts`
- Create: `packages/skill-market-server/test/skillhub-evaluation-store.test.ts`
- Modify: `packages/schema/src/skill-market-control.ts`

**Interfaces:**
- Produces: `createSkillHubEvaluationStore({ database, now })`.
- Methods: `claim(workerID, limit, leaseMilliseconds)`, `renew`, `complete`, `retry`, `progress`, `markDue`.
- Produces: `SkillMarketControl.SkillHubEvaluationProgress`.

- [ ] **Step 1: Write failing queue tests**

Cover FIFO claim, maximum two-item claim, lease renewal, stale-worker fencing, completion, exponential retry, terminal failure after the configured attempt limit, restart recovery, seven-day refresh, and aggregate progress.

```ts
expect(store.claim("worker-a", 2, 60_000).map((item) => item.slug)).toEqual(["a", "b"])
expect(store.complete("worker-b", "a", evaluation)).toBe(false)
expect(store.complete("worker-a", "a", evaluation)).toBe(true)
expect(store.progress()).toMatchObject({ total: 2, completed: 1, pending: 1, failed: 0 })
```

- [ ] **Step 2: Run the store tests to verify failure**

```bash
bun test test/skillhub-evaluation-store.test.ts
```

Expected: FAIL because the store and progress schema do not exist.

- [ ] **Step 3: Implement transactions and progress schema**

The completion update must fence on worker and unexpired lease, set all six scores, clear retry/error/lease fields, set `evaluation_checked_at`, and merge `evaluationScore` and `traceEvaluation` into `summary_json` using decoded schema objects. Retry delay is capped exponential backoff; error summaries are trimmed to 500 characters.

```ts
export const SkillHubEvaluationProgress = Schema.Struct({
  total: NonNegative,
  waiting: NonNegative,
  pending: NonNegative,
  running: NonNegative,
  retryWait: NonNegative,
  completed: NonNegative,
  failed: NonNegative,
  ratePerMinute: NonNegative,
  estimatedSecondsRemaining: NonNegative.pipe(optional),
  recentError: bounded(1, 500).pipe(optional),
})
```

- [ ] **Step 4: Run store and schema tests**

```bash
bun test test/skillhub-evaluation-store.test.ts ../protocol/test/skill-market-control.test.ts
```

Expected: PASS; a stale worker cannot complete another worker's lease.

- [ ] **Step 5: Commit**

```bash
git add src/skillhub-evaluation-store.ts test/skillhub-evaluation-store.test.ts ../schema/src/skill-market-control.ts
git commit -m "feat(skill-market): persist trace progress"
```

### Task 5: Update mirrored detail objects and publish evaluated catalog entries

**Files:**
- Modify: `packages/skill-market-server/src/skillhub-mirror.ts`
- Modify: `packages/skill-market-server/src/skillhub-import-store.ts`
- Modify: `packages/skill-market-server/src/publisher.ts`
- Modify: `packages/skill-market-server/test/skillhub-mirror.test.ts`
- Modify: `packages/skill-market-server/test/publisher.test.ts`

**Interfaces:**
- Consumes: completed evaluation rows from Task 4.
- Produces: new mirror details with no fake `evaluationScore`; evaluation completion can write a new content-addressed detail and update the import row before publication.

- [ ] **Step 1: Write failing mirror and publication tests**

Assert a new upstream `score: 100000` is retained only in the private record and the public detail omits `evaluationScore`. Then seed a completed evaluation and assert publication creates a detail with `evaluationScore: 4.45`, updates the index summary, and preserves package hashes, aliases, featured state, and source status.

- [ ] **Step 2: Run focused tests to verify failure**

```bash
bun test test/skillhub-mirror.test.ts test/publisher.test.ts
```

Expected: FAIL because mirror details still expose the raw score and publisher has no evaluation overlay.

- [ ] **Step 3: Implement evaluation-aware publication**

Set legacy `score` to `0` only in newly materialized public SkillHub details and omit `evaluationScore` until a completed result exists. Add a publisher operation that loads the current detail, applies:

```ts
const evaluated = {
  ...detail,
  evaluationScore: result.score,
  traceEvaluation: {
    trust: result.trust,
    reliability: result.reliability,
    adaptability: result.adaptability,
    convention: result.convention,
    effectiveness: result.effectiveness,
    evaluatedAt: new Date(result.checkedAt).toISOString(),
  },
}
```

Content-address and store the new detail, update the import item's `summary_json`, `detail_key`, and `detail_sha256` under its evaluation lease, then call `publishMirroredSkillHub` for a bounded batch. Reuse the existing catalog lease; do not write the pointer outside `Publisher.withCatalogLease`.

- [ ] **Step 4: Run tests**

```bash
bun test test/skillhub-mirror.test.ts test/publisher.test.ts test/skillhub-import-store.test.ts
```

Expected: PASS; publication is atomic and preserves immutable package metadata.

- [ ] **Step 5: Commit**

```bash
git add src/skillhub-mirror.ts src/skillhub-import-store.ts src/publisher.ts test/skillhub-mirror.test.ts test/publisher.test.ts test/skillhub-import-store.test.ts
git commit -m "feat(skill-market): publish trace scores"
```

### Task 6: Add the bounded evaluation worker and configuration

**Files:**
- Create: `packages/skill-market-server/src/skillhub-evaluation-worker.ts`
- Create: `packages/skill-market-server/test/skillhub-evaluation-worker.test.ts`
- Modify: `packages/skill-market-server/src/config.ts`
- Modify: `packages/skill-market-server/test/sources.test.ts`
- Modify: `packages/skill-market-server/package.json`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: `runSkillHubEvaluationWorker` and package script `evaluation-worker`.

- [ ] **Step 1: Write failing worker and config tests**

Assert defaults of concurrency `2`, requests per minute `60`, refresh days `7`, and publication batch `100`. Use a fake clock to prove no more than one request begins per second, two requests may be active, a failed item does not stop the batch, and a rerun resumes durable state.

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test test/skillhub-evaluation-worker.test.ts test/sources.test.ts
```

Expected: FAIL because configuration and worker are absent.

- [ ] **Step 3: Implement the worker**

Add bounded config values and a worker loop with a 50-second default budget. Gate every request start through one shared scheduler so two concurrent requests still produce at most 60 starts per minute:

```ts
const interval = Math.ceil(60_000 / requestsPerMinute)
let nextStart = now()
const schedule = async () => {
  const delay = Math.max(0, nextStart - now())
  nextStart = Math.max(nextStart, now()) + interval
  if (delay > 0) await wait(delay)
}
```

The worker must call `schedule()` immediately before each fetch, start at most `concurrency` items, renew leases during fetch/store, call `retry` on upstream/storage failures, publish after `100` newly completed evaluations or 30 minutes, close the database in `finally`, and emit counts without error bodies.

- [ ] **Step 4: Run tests and typecheck**

```bash
bun test test/skillhub-evaluation-worker.test.ts test/sources.test.ts
bun typecheck
```

Expected: PASS with fake-clock rate limiting and restart continuation.

- [ ] **Step 5: Commit**

```bash
git add src/skillhub-evaluation-worker.ts test/skillhub-evaluation-worker.test.ts src/config.ts test/sources.test.ts package.json
git commit -m "feat(skill-market): run trace backfill"
```

### Task 7: Expose and render independent TRACE progress

**Files:**
- Modify: `packages/protocol/src/groups/skill-market-admin.ts`
- Modify: `packages/protocol/test/skill-market-control.test.ts`
- Modify: `packages/skill-market-server/src/skillhub-import-admin.ts`
- Modify: `packages/skill-market-server/src/http/admin.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Modify: `packages/skill-market-server/test/control-http.test.ts`
- Modify: `packages/skill-market-web/src/control-data-source.ts`
- Modify: `packages/skill-market-web/src/control-data-source.test.ts`
- Modify: `packages/skill-market-web/src/admin/skillhub.tsx`
- Modify: `packages/skill-market-web/src/admin/skillhub.test.tsx`

**Interfaces:**
- Produces: `GET /v1/admin/skillhub-evaluation` returning `SkillHubEvaluationProgress` to admins only.

- [ ] **Step 1: Write failing protocol, HTTP, source, and UI tests**

Assert route registration, `401` without a session, `403` for non-admin, a decoded progress response for admin, and a UI section labeled `TRACE 评分补齐` showing completed, pending, failed, rate, and ETA independently from content sync.

- [ ] **Step 2: Run focused tests to verify failure**

```bash
cd packages/protocol && bun test test/skill-market-control.test.ts
cd ../skill-market-server && bun test test/control-http.test.ts
cd ../skill-market-web && bun test src/control-data-source.test.ts src/admin/skillhub.test.tsx
```

Expected: FAIL because the route and panel do not exist.

- [ ] **Step 3: Add endpoint and UI wiring**

Add the endpoint:

```ts
HttpApiEndpoint.get("skillMarket.admin.skillhub.evaluation", "/v1/admin/skillhub-evaluation", {
  success: SkillMarketControl.SkillHubEvaluationProgress,
})
```

Require admin server-side, expose `source.skillhub.evaluation(signal)`, query every five seconds while pending/running/retry work exists, and render a separate progress bar. Do not merge evaluation failures into the content import error banner.

- [ ] **Step 4: Regenerate client and run tests**

```bash
cd packages/client && bun run generate
cd ../protocol && bun test test/skill-market-control.test.ts
cd ../skill-market-server && bun test test/control-http.test.ts
cd ../skill-market-web && bun test src/control-data-source.test.ts src/admin/skillhub.test.tsx
```

Expected: PASS and generated clients include the new endpoint.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/client packages/skill-market-server packages/skill-market-web
git commit -m "feat(skill-market): show trace progress"
```

### Task 8: Package, deploy, and verify the backfill

**Files:**
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-evaluation.service`
- Create: `packages/skill-market-server/deploy/systemd/ruying-skill-market-evaluation.timer`
- Modify: `packages/skill-market-server/deploy/systemd.test.ts`
- Modify: `packages/skill-market-server/script/build-release.ts`
- Modify: `packages/skill-market-server/script/build-release.test.ts`
- Modify: `packages/skill-market-server/deploy/ruying-skill-market.env.example`
- Modify: `packages/skill-market-server/deploy/README.md`
- Modify: `packages/skill-market-server/README.md`

**Interfaces:**
- Produces: release artifact containing `src/skillhub-evaluation-worker.js` and a persistent one-minute timer.

- [ ] **Step 1: Write failing release and systemd tests**

Assert the release contains the worker, the service uses a dedicated `/run/lock/ruying-skill-market-evaluation.lock`, `MemoryMax=1536M`, the existing `ruying-market` account and hardening, and the timer is persistent with one-minute cadence.

- [ ] **Step 2: Run tests to verify failure**

```bash
cd packages/skill-market-server
bun test script/build-release.test.ts deploy/systemd.test.ts script/deploy-check.test.ts
```

Expected: FAIL because the worker and units are not packaged.

- [ ] **Step 3: Add release and systemd wiring**

Add `{ source: "src/skillhub-evaluation-worker.ts", output: "src/skillhub-evaluation-worker.js" }` to the release build. Configure the oneshot service to execute the built `.js`, read the existing market environment file, write only approved data/backup/lock paths, and use the dedicated lock. Document:

```dotenv
SKILL_MARKET_EVALUATION_CONCURRENCY=2
SKILL_MARKET_EVALUATION_REQUESTS_PER_MINUTE=60
SKILL_MARKET_EVALUATION_REFRESH_DAYS=7
SKILL_MARKET_EVALUATION_PUBLISH_BATCH=100
```

- [ ] **Step 4: Run the full relevant suite and build releases**

```bash
cd packages/schema && bun typecheck
cd ../protocol && bun test && bun typecheck
cd ../skill-market-server && bun test && bun typecheck && bun run build:release
cd ../app && bun test src/skill-market && bun typecheck
cd ../skill-market-web && bun test && bun typecheck && bun run build && bun run release
```

Expected: all commands PASS and both API and Web artifacts are created.

- [ ] **Step 5: Commit deployment wiring**

```bash
git add packages/skill-market-server/deploy packages/skill-market-server/script packages/skill-market-server/README.md
git commit -m "chore(skill-market): deploy trace worker"
```

- [ ] **Step 6: Deploy API and Web, then verify production**

Build from the committed revision, transfer the API release and Web release to `root@10.246.13.226` over SSH port `9922`, install under immutable release directories, run migration 005 as `ruying-market`, atomically switch release links, install/verify the evaluation units, restart the API, and enable the timer. Do not print environment secrets.

Verify:

```bash
curl -fsS http://127.0.0.1:4210/v1/catalog/skills/skillhub/ai-intelligence-investigator
systemctl status ruying-skill-market-evaluation.timer --no-pager
systemctl status ruying-skill-market-evaluation.service --no-pager
```

Expected: the public page never renders `100000.0`; after evaluation the sample API returns `evaluationScore` near `4.45` and UI displays `4.5/5`; admin progress increases across timer runs; disk IO remains below saturation; content mirror continues independently.

- [ ] **Step 7: Commit the verified release marker if the repository uses one**

No repository marker is currently required. Record the deployed git SHA and Web release ID in the task handoff, not in source files.
