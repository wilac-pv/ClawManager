# Skill Market Lifecycle Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recoverable personal Skill deletion, safe submission withdrawal, and audited delisting requests without allowing stale workers to publish removed content.

**Architecture:** Model trash, withdrawal, and delisting as explicit durable states with optimistic versions and background-work fences. Hide content immediately, retain recoverable artifacts for seven days, then use the existing cleanup timer to purge private objects idempotently while preserving audit metadata.

**Tech Stack:** Bun, TypeScript, Effect HttpApi, Effect Schema, SQLite, SolidJS, systemd cleanup timer, private OSS.

## Global Constraints

- Personal deletion is recoverable for exactly seven days and immediately blocks reads.
- Withdrawal is allowed only from `validating`, `validation_failed`, `pending_review`, `changes_requested`, and `publish_failed`.
- `publishing` cannot be withdrawn; published content uses an administrator-approved delisting request.
- Scanner, reviewer, and publisher continuations must recheck durable state before transition.
- Withdrawn artifacts purge after seven days; audit events and non-sensitive submission metadata remain.
- All destructive writes require session, origin, CSRF, optimistic version, confirmation UI, and audit events.
- Run tests and `bun typecheck` from package directories.

---

### Task 1: Define lifecycle contracts and migrate durable states

**Files:**
- Modify: `packages/schema/src/skill-market-control.ts`
- Modify: `packages/protocol/src/groups/skill-market-submissions.ts`
- Modify: `packages/protocol/src/groups/skill-market-admin.ts`
- Create: `packages/skill-market-server/migrations/012_lifecycle_actions.sql`
- Test: `packages/schema/test/skill-market-control.test.ts`
- Test: `packages/protocol/test/skill-market-control.test.ts`
- Test: `packages/skill-market-server/test/database.test.ts`
- Regenerate: `packages/client/src/generated/`
- Regenerate: `packages/client/src/generated-effect/`

**Interfaces:**
- Produces: `withdrawn` status, `PersonalTrashItem`, `DelistRequest`, and typed delete/restore/withdraw/delist operations.

- [ ] **Step 1: Write failing contract tests**

```ts
expect(SkillMarketControl.SubmissionStatus.literals).toContain("withdrawn")
expect(apiEndpointNames()).toContain("skillMarket.submissions.withdraw")
expect(apiEndpointNames()).toContain("skillMarket.submissions.personalDelete")
expect(apiEndpointNames()).toContain("skillMarket.admin.approveDelist")
```

- [ ] **Step 2: Run focused tests and verify RED**

Run from `packages/schema`: `bun test test/skill-market-control.test.ts`

Run from `packages/protocol`: `bun test test/skill-market-control.test.ts`

Expected: lifecycle schemas and endpoints are missing.

- [ ] **Step 3: Add exact lifecycle models and migration**

```sql
ALTER TABLE submissions ADD COLUMN deleted_at INTEGER;
ALTER TABLE submissions ADD COLUMN purge_after INTEGER;
CREATE TABLE delist_requests (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  requested_by_employee_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
```

Rebuild the SQLite `submissions` table in the migration so its status CHECK includes `withdrawn`; preserve indexes, foreign keys, IDs, versions, and all existing rows.

- [ ] **Step 4: Regenerate and verify GREEN**

Run from `packages/client`: `bun run generate && bun run check:generated && bun test && bun typecheck`

Run from `packages/skill-market-server`: `bun test test/database.test.ts`

Expected: migrated fixtures preserve prior rows and expose new lifecycle fields.

- [ ] **Step 5: Commit contracts and migration**

```bash
git add packages/schema/src/skill-market-control.ts packages/schema/test/skill-market-control.test.ts packages/protocol/src/groups/skill-market-submissions.ts packages/protocol/src/groups/skill-market-admin.ts packages/protocol/test/skill-market-control.test.ts packages/client/src/generated packages/client/src/generated-effect packages/skill-market-server/migrations/012_lifecycle_actions.sql packages/skill-market-server/test/database.test.ts
git commit -m "feat(skill-market): define lifecycle actions"
```

### Task 2: Implement personal trash, restore, and seven-day purge

**Files:**
- Create: `packages/skill-market-server/src/personal-trash.ts`
- Create: `packages/skill-market-server/src/http/personal-trash.ts`
- Modify: `packages/skill-market-server/src/submissions.ts`
- Modify: `packages/skill-market-server/src/http/submissions.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Modify: `packages/skill-market-server/script/cleanup.ts`
- Test: `packages/skill-market-server/test/submissions.test.ts`
- Create: `packages/skill-market-server/test/personal-trash.test.ts`
- Modify: `packages/skill-market-server/script/cleanup.test.ts`

**Interfaces:**
- Produces: owner-only `trash`, `deletePersonal`, `restorePersonal`, and idempotent `purgeExpiredPersonal` operations.

- [ ] **Step 1: Write failing deletion and purge tests**

```ts
const deleted = trash.deletePersonal(alice, personal.id, personal.version)
expect(deleted.purgeAfter).toBe("2026-08-11T00:00:00.000Z")
expect(() => submissions.personalPackage(alice, personal.id)).toThrow("not-found")
expect(trash.restorePersonal(alice, personal.id, deleted.version).deletedAt).toBeUndefined()
clock.value += 7 * 24 * 60 * 60_000
await purgeExpiredPersonal()
expect(privateObjects.has(personal.packageKey)).toBe(false)
```

- [ ] **Step 2: Run tests and verify RED**

Run from `packages/skill-market-server`: `bun test test/personal-trash.test.ts test/submissions.test.ts script/cleanup.test.ts`

Expected: trash service and deletion filters are absent.

- [ ] **Step 3: Implement soft deletion and restoration**

Set `deleted_at = now` and `purge_after = now + 7 * 24 * 60 * 60_000` only for owner-owned, personal, published rows matching the optimistic version. Add `deleted_at IS NULL` to normal personal list/detail/package queries. Restore only before `purge_after`, clear both timestamps, increment version, and audit both operations.

- [ ] **Step 4: Implement idempotent cleanup**

Claim expired rows, recheck the deadline, delete package/icon/manifest/scan keys, retain submission and audit metadata, and mark artifact identity purged so retries do not reread deleted objects. Never delete shared publications derived from the personal package.

- [ ] **Step 5: Verify and commit**

Run from `packages/skill-market-server`: `bun test test/personal-trash.test.ts test/submissions.test.ts script/cleanup.test.ts && bun typecheck`

```bash
git add packages/skill-market-server/src/personal-trash.ts packages/skill-market-server/src/http/personal-trash.ts packages/skill-market-server/src/submissions.ts packages/skill-market-server/src/http/submissions.ts packages/skill-market-server/src/handlers.ts packages/skill-market-server/src/server.ts packages/skill-market-server/script/cleanup.ts packages/skill-market-server/test/personal-trash.test.ts packages/skill-market-server/test/submissions.test.ts packages/skill-market-server/script/cleanup.test.ts
git commit -m "feat(skill-market): add personal Skill trash"
```

### Task 3: Fence withdrawal and administrator-approved delisting

**Files:**
- Create: `packages/skill-market-server/src/lifecycle.ts`
- Modify: `packages/skill-market-server/src/submissions.ts`
- Modify: `packages/skill-market-server/src/moderation.ts`
- Modify: `packages/skill-market-server/src/publisher.ts`
- Modify: `packages/skill-market-server/src/worker.ts`
- Modify: `packages/skill-market-server/src/http/submissions.ts`
- Modify: `packages/skill-market-server/src/http/admin.ts`
- Test: `packages/skill-market-server/test/submissions.test.ts`
- Test: `packages/skill-market-server/test/moderation.test.ts`
- Test: `packages/skill-market-server/test/publisher.test.ts`
- Test: `packages/skill-market-server/test/worker.test.ts`
- Test: `packages/skill-market-server/test/control-http.test.ts`

**Interfaces:**
- Produces: `withdraw`, `requestDelist`, `decideDelist`, and `requireLifecycleFence`.

- [ ] **Step 1: Write failing transition and race tests**

```ts
for (const status of ["validating", "validation_failed", "pending_review", "changes_requested", "publish_failed"])
  expect(withdraw(status)).toMatchObject({ status: "withdrawn" })
expect(() => withdraw("publishing")).toThrow("submission-conflict")
expect(() => withdraw("published")).toThrow("submission-conflict")
await staleWorker.completeValidation(withdrawn.id)
expect(read(withdrawn.id).status).toBe("withdrawn")
```

- [ ] **Step 2: Run tests and verify RED**

Run from `packages/skill-market-server`: `bun test test/submissions.test.ts test/moderation.test.ts test/publisher.test.ts test/worker.test.ts test/control-http.test.ts`

Expected: `withdrawn` transition and durable fences are missing.

- [ ] **Step 3: Implement withdrawal with version fences**

Update status to `withdrawn` only from the five allowed states and only at the expected version. Clear leases and user messages, increment version, and audit. Scanner and publisher completion SQL must include the claimed status, revision, and version so stale work updates zero rows and exits without publication.

- [ ] **Step 4: Implement delisting requests and decisions**

Owners create one pending request per published submission with a bounded reason. Admin approval first removes public/restricted catalog visibility transactionally, records the decision, then queues artifact cleanup. Rejection leaves publication unchanged. Every decision uses optimistic request versioning.

- [ ] **Step 5: Verify and commit**

Run from `packages/skill-market-server`: `bun test test/submissions.test.ts test/moderation.test.ts test/publisher.test.ts test/worker.test.ts test/control-http.test.ts && bun typecheck`

```bash
git add packages/skill-market-server/src/lifecycle.ts packages/skill-market-server/src/submissions.ts packages/skill-market-server/src/moderation.ts packages/skill-market-server/src/publisher.ts packages/skill-market-server/src/worker.ts packages/skill-market-server/src/http/submissions.ts packages/skill-market-server/src/http/admin.ts packages/skill-market-server/test/submissions.test.ts packages/skill-market-server/test/moderation.test.ts packages/skill-market-server/test/publisher.test.ts packages/skill-market-server/test/worker.test.ts packages/skill-market-server/test/control-http.test.ts
git commit -m "feat(skill-market): add withdrawal and delisting"
```

### Task 4: Add trash, withdrawal, and delisting Web actions

**Files:**
- Create: `packages/skill-market-web/src/space/trash.tsx`
- Create: `packages/skill-market-web/src/space/trash.test.tsx`
- Modify: `packages/skill-market-web/src/control-data-source.ts`
- Modify: `packages/skill-market-web/src/control-data-source.test.ts`
- Modify: `packages/skill-market-web/src/submissions/detail.tsx`
- Modify: `packages/skill-market-web/src/submissions/detail.test.tsx`
- Modify: `packages/skill-market-web/src/submissions/list.tsx`
- Modify: `packages/skill-market-web/src/submissions/list.test.tsx`
- Modify: `packages/skill-market-web/src/space/layout.tsx`
- Modify: `packages/skill-market-web/src/space/layout.test.tsx`
- Modify: `packages/skill-market-web/src/app.tsx`
- Modify: `packages/skill-market-web/src/admin/review.tsx`
- Modify: `packages/skill-market-web/src/admin/review.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3 lifecycle endpoints.
- Produces: confirmation dialogs, `/trash`, restore, withdraw, delist request, and admin decision UI.

- [ ] **Step 1: Write failing interaction tests**

```tsx
fireEvent.click(view.getByRole("button", { name: "删除个人 Skill" }))
expect(view.getByRole("dialog")).toHaveTextContent("代码审查助手 1.2.0")
fireEvent.click(view.getByRole("button", { name: "确认删除" }))
expect(deletePersonal).toHaveBeenCalledWith("sub_abcdefgh", 4)
expect(view.getByRole("button", { name: "撤回投稿" })).toBeTruthy()
```

- [ ] **Step 2: Run browser tests and verify RED**

Run from `packages/skill-market-web`: `bun run test:browser`

Expected: trash route and destructive actions are absent.

- [ ] **Step 3: Add data-source methods and accessible UI**

Show delete only for active personal published rows, withdraw only in allowed states, and request delisting only when published. Confirmation dialogs receive initial focus, name the exact item, close on Escape, restore focus, disable duplicate submits, and surface request IDs on errors. Add **回收站** to **我的空间** and display purge deadline plus restore action.

- [ ] **Step 4: Verify and commit**

Run from `packages/skill-market-web`: `bun run test:unit && bun run test:browser && bun typecheck && bun run build`

```bash
git add packages/skill-market-web/src/space/trash.tsx packages/skill-market-web/src/space/trash.test.tsx packages/skill-market-web/src/control-data-source.ts packages/skill-market-web/src/control-data-source.test.ts packages/skill-market-web/src/submissions packages/skill-market-web/src/space/layout.tsx packages/skill-market-web/src/space/layout.test.tsx packages/skill-market-web/src/app.tsx packages/skill-market-web/src/admin/review.tsx packages/skill-market-web/src/admin/review.test.tsx
git commit -m "feat(skill-market): add lifecycle actions UI"
```

### Task 5: Verify cleanup deployment and rollback

**Files:**
- Modify: `packages/skill-market-server/deploy/systemd/ruying-skill-market-cleanup.service`
- Modify: `packages/skill-market-server/deploy/systemd.test.ts`
- Modify: `packages/skill-market-server/script/backup.ts`
- Modify: `packages/skill-market-server/script/backup.test.ts`
- Modify: `packages/skill-market-server/README.md`
- Modify: `packages/skill-market-server/deploy/README.md`
- Modify: `packages/skill-market-web/e2e/fixtures/server.ts`
- Modify: `packages/skill-market-web/e2e/market.e2e.ts`

**Interfaces:**
- Consumes: complete lifecycle implementation.
- Produces: backup coverage, timer resource limits, rollback instructions, and end-to-end acceptance.

- [ ] **Step 1: Add failing seven-day and race E2E cases**

Verify delete → hidden → restore, delete → seven-day purge, withdraw while scanner holds a lease, and delist approval → invisible before cleanup.

- [ ] **Step 2: Run deployment and E2E tests and verify RED**

Run from `packages/skill-market-server`: `bun test deploy/systemd.test.ts script/backup.test.ts`

Run from `packages/skill-market-web`: `bun run test:e2e`

- [ ] **Step 3: Update cleanup unit, backup manifest, and runbooks**

Keep cleanup bounded by the existing service identity, memory limit, timeout, and private prefix. Document restoration before deadline, irreversible purge after deadline, withdrawal state rollback, and delisting visibility-first ordering.

- [ ] **Step 4: Run complete package gates and commit**

Run from `packages/skill-market-server`: `bun test && bun typecheck`

Run from `packages/skill-market-web`: `bun test && bun typecheck && bun run build && bun run test:e2e`

```bash
git add packages/skill-market-server/deploy/systemd/ruying-skill-market-cleanup.service packages/skill-market-server/deploy/systemd.test.ts packages/skill-market-server/script/backup.ts packages/skill-market-server/script/backup.test.ts packages/skill-market-server/README.md packages/skill-market-server/deploy/README.md packages/skill-market-web/e2e
git commit -m "test(skill-market): verify lifecycle cleanup"
```
