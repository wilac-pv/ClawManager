# Ruying Skill Market Submission Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `skill-market-server` 中增加 GWM SSO、投稿、自动校验、人工审核、角色管理、审计和幂等社区发布能力，同时保持匿名公共目录兼容。

**Architecture:** Schema 定义目录与控制面 DTO，Protocol 将公共目录、身份、投稿和管理拆成独立 HttpApi 组；`skill-market-server` 使用 Effect HttpApi 提供路由，使用 `bun:sqlite` 保存可变状态，使用私有 OSS 隔离投稿包，并通过单租约发布任务将已审核的 `community` 版本合入统一不可变目录快照。所有状态推进、审核和审计在 SQLite 事务中完成，目录指针始终最后更新且支持崩溃恢复。

**Tech Stack:** Bun 1.3.14、TypeScript、Effect Schema/HttpApi、`bun:sqlite`、AWS S3 SDK、Bun test、真实 ZIP fixtures。

## Global Constraints

- 目标分支为 `ruying-code-oem`；不要修改用户未跟踪的 `.codegraph/` 和 `.superpowers/brainstorm/`。
- 保持 Schema → Protocol → Server 依赖方向；Web/App 不能依赖 Server 运行时代码。
- 不直接编辑 `packages/client/src/generated` 或 `packages/client/src/generated-effect`；Protocol 完成后从 `packages/client` 运行 `bun run generate`。
- `/v1/catalog/*` 继续匿名支持 `GET/HEAD/OPTIONS` 和 `Access-Control-Allow-Origin: *`；控制面只允许配置的同源 Origin。
- ZIP 只能静态解析和扫描，绝不执行包内脚本、二进制或测试。
- SSO Token、AI 网关 Key、会话值、CSRF 值、疑似凭据正文、OSS AK/SK 和私有 OSS Key 不得进入日志、DTO 或审计摘要。
- SQLite 使用 WAL、外键和事务，数据库列使用 snake_case；迁移失败时服务不得开始监听。
- 测试和 `bun typecheck` 必须从对应 package 目录运行。

---

## File Structure

- `packages/schema/src/skill-market.ts`：为公共来源增加 `community`，补充社区作者和审核信息。
- `packages/schema/src/skill-market-control.ts`：会话、投稿、修订、扫描、审核、角色、审计和稳定错误 DTO。
- `packages/protocol/src/groups/skill-market-auth.ts`：SSO 登录和会话合约。
- `packages/protocol/src/groups/skill-market-submissions.ts`：投稿者列表、详情和流式上传合约。
- `packages/protocol/src/groups/skill-market-admin.ts`：审核、角色、审计、发布重试与上下架合约。
- `packages/skill-market-server/migrations/001_control_plane.sql`：首版 SQLite 表、索引和约束。
- `packages/skill-market-server/src/database.ts`：迁移、事务和查询边界。
- `packages/skill-market-server/src/auth.ts`：登录 attempt、SSO 回调、会话和 Cookie。
- `packages/skill-market-server/src/security.ts`：Origin、CSRF、RBAC、限额和请求关联 ID。
- `packages/skill-market-server/src/submission-archive.ts`：流式接收、ZIP 结构验证、图标验证和私有 OSS 写入。
- `packages/skill-market-server/src/scanner.ts`：无执行静态扫描和脱敏证据。
- `packages/skill-market-server/src/submissions.ts`：投稿状态机、幂等创建、修订和所有权。
- `packages/skill-market-server/src/moderation.ts`：审核、角色、审计、下架和恢复。
- `packages/skill-market-server/src/community.ts`：社区 Skill 详情构造与公开对象复制。
- `packages/skill-market-server/src/publisher.ts`：发布任务租约、统一快照和崩溃恢复。
- `packages/skill-market-server/src/http/`：四组 HttpApi handlers 和安全中间件。
- `packages/skill-market-server/src/server.ts`：迁移后启动统一 Effect HTTP 服务。
- `packages/skill-market-server/src/sync.ts`：先恢复发布任务，再同步外部来源。
- `packages/skill-market-server/test/`：真实数据库、HTTP、ZIP、安全、并发和恢复测试。

### Task 1: Extend shared catalog and control-plane schemas

**Files:**
- Modify: `packages/schema/src/skill-market.ts`
- Create: `packages/schema/src/skill-market-control.ts`
- Modify: `packages/schema/package.json`
- Modify: `packages/schema/test/skill-market.test.ts`
- Create: `packages/schema/test/skill-market-control.test.ts`

**Interfaces:**
- Extends: `SkillMarket.Source` from `skillhub | enterprise` to `skillhub | enterprise | community`.
- Produces: `SkillMarketControl.Session`, `SubmissionSummary`, `SubmissionDetail`, `SubmissionMetadata`, `Revision`, `ScanReport`, `Review`, `RoleAssignment`, `AuditEvent`, query/page schemas and stable `Problem` response.
- Preserves: all existing public catalog payloads; only optional community-specific fields are added.

- [ ] **Step 1: Write failing schema tests for the third source and stable control vocabulary**

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SkillMarket } from "../src/skill-market"
import { SkillMarketControl } from "../src/skill-market-control"

describe("SkillMarketControl", () => {
  test("accepts community as a public source", () => {
    expect(Schema.decodeUnknownSync(SkillMarket.Source)("community")).toBe("community")
  })

  test("rejects an unknown submission transition value", () => {
    expect(() => Schema.decodeUnknownSync(SkillMarketControl.SubmissionStatus)("approved")).toThrow()
  })

  test("decodes a conflict without internal details", () => {
    expect(
      Schema.decodeUnknownSync(SkillMarketControl.Problem)({
        code: "submission-conflict",
        message: "投稿已发生变化，请刷新后重试",
        requestId: "req_01",
      }).code,
    ).toBe("submission-conflict")
  })
})
```

- [ ] **Step 2: Run the focused schema test and verify it fails**

Run: `cd packages/schema && bun test test/skill-market-control.test.ts`

Expected: FAIL because `skill-market-control.ts` does not exist and `community` is not accepted.

- [ ] **Step 3: Add the exact stable literals and same-name interfaces**

Define these literals without free-form fallback values:

```ts
export const SubmissionStatus = Schema.Literals([
  "validating",
  "validation_failed",
  "pending_review",
  "changes_requested",
  "rejected",
  "publishing",
  "publish_failed",
  "published",
])
export interface SubmissionStatus extends Schema.Schema.Type<typeof SubmissionStatus> {}

export const ReviewDecision = Schema.Literals(["approve", "request_changes", "reject"])
export interface ReviewDecision extends Schema.Schema.Type<typeof ReviewDecision> {}

export const Role = Schema.Literals(["reviewer", "admin"])
export interface Role extends Schema.Schema.Type<typeof Role> {}
```

Add bounded strings/arrays for display name, description, category, tags, license and change notes; canonical SemVer; opaque IDs; pagination; risk evidence containing only `path`, `line`, `rule` and redacted `summary`. Define terminal and active status arrays once and test them.

- [ ] **Step 4: Add public community metadata as optional fields**

Add optional `submittedBy: { displayName: string }`, `reviewedAt` and `reviewRisk` fields to `SkillMarket.Summary`/`Detail`; extend `SourceStatus` with a `community` freshness field. Public DTOs must not contain the submitter's employee ID. Existing SkillHub/enterprise fixtures must still decode after their expected `sourceStatus` is updated.

- [ ] **Step 5: Export the new namespace and run schema tests/typecheck**

Run:

```bash
cd packages/schema
bun test test/skill-market.test.ts test/skill-market-control.test.ts
bun typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit the schema boundary**

```bash
git add packages/schema
git commit -m "feat(schema): define market submissions"
```

### Task 2: Declare auth, submission, and administration HttpApi groups

**Files:**
- Create: `packages/protocol/src/groups/skill-market-auth.ts`
- Create: `packages/protocol/src/groups/skill-market-submissions.ts`
- Create: `packages/protocol/src/groups/skill-market-admin.ts`
- Modify: `packages/protocol/src/skill-market-api.ts`
- Modify: `packages/protocol/src/groups/skill-market-catalog.ts`
- Create: `packages/protocol/test/skill-market-control.test.ts`

**Interfaces:**
- Auth: login redirect, callback, current session, logout.
- Submitter: own list/detail, create multipart submission, append multipart revision.
- Admin: review queue/detail/decision, retry publish, roles, audit, delist and restore.
- Upload payload: `HttpApiSchema.asMultipartStream` with a streamed ZIP part, optional icon part and JSON metadata field.

- [ ] **Step 1: Write a failing OpenAPI contract test**

Assert all routes and methods from the approved spec exist, upload endpoints consume `multipart/form-data`, and public catalog operations do not inherit control-plane authorization middleware.

- [ ] **Step 2: Run the protocol test and verify missing groups**

Run: `cd packages/protocol && bun test test/skill-market-control.test.ts`

Expected: FAIL because the auth, submission and admin groups are absent.

- [ ] **Step 3: Define reusable typed errors and optimistic concurrency inputs**

Use Schema error classes with status codes for `401 unauthenticated`, `403 forbidden`, `403 csrf-invalid`, `409 submission-conflict`, `409 skill-owned-by-another-user`, `409 last-admin`, `413 upload-too-large`, `422 validation-failed`, `429 upload-rate-limited`, and `503 dependency-unavailable`. Decision, revision, retry, delist and restore payloads must include `expectedVersion`.

- [ ] **Step 4: Declare the three control groups and keep catalog separate**

Use these exact endpoint names and paths:

```text
skillMarket.auth.login                   GET    /v1/auth/login
skillMarket.auth.callback                GET    /v1/auth/callback/:attemptID
skillMarket.auth.session                 GET    /v1/auth/session
skillMarket.auth.logout                  DELETE /v1/auth/session
skillMarket.submissions.list             GET    /v1/submissions
skillMarket.submissions.create           POST   /v1/submissions
skillMarket.submissions.detail           GET    /v1/submissions/:submissionID
skillMarket.submissions.revise           POST   /v1/submissions/:submissionID/revisions
skillMarket.admin.submissions.list       GET    /v1/admin/submissions
skillMarket.admin.submissions.detail     GET    /v1/admin/submissions/:submissionID
skillMarket.admin.submissions.decision   POST   /v1/admin/submissions/:submissionID/decision
skillMarket.admin.submissions.retry      POST   /v1/admin/submissions/:submissionID/retry-publish
skillMarket.admin.roles.list             GET    /v1/admin/roles
skillMarket.admin.roles.create           POST   /v1/admin/roles
skillMarket.admin.roles.delete           DELETE /v1/admin/roles/:employeeID/:role
skillMarket.admin.audit.list             GET    /v1/admin/audit
skillMarket.admin.community.delist       POST   /v1/admin/community-skills/:skillID/delist
skillMarket.admin.community.restore      POST   /v1/admin/community-skills/:skillID/restore
```

- [ ] **Step 5: Compose a full API while preserving the catalog-only export**

Keep `SkillMarketCatalogApi` for anonymous consumers and export `SkillMarketApi` containing all four groups for the server. Annotate auth and write endpoints as cookie/CSRF protected in OpenAPI without putting secrets in query parameters.

- [ ] **Step 6: Test, typecheck, regenerate clients, and commit**

Run:

```bash
cd packages/protocol
bun test test/skill-market-catalog.test.ts test/skill-market-control.test.ts
bun typecheck
cd ../client
bun run generate
bun typecheck
```

Expected: contract tests PASS, generation changes only generated client files, both typechecks exit 0.

```bash
git add packages/protocol packages/client
git commit -m "feat(protocol): add market control api"
```

### Task 3: Add SQLite migrations and transactional repositories

**Files:**
- Create: `packages/skill-market-server/migrations/001_control_plane.sql`
- Create: `packages/skill-market-server/src/database.ts`
- Create: `packages/skill-market-server/test/database.test.ts`
- Modify: `packages/skill-market-server/src/config.ts`
- Modify: `packages/skill-market-server/package.json`

**Interfaces:**
- `openDatabase(config)` migrates before returning and owns WAL/foreign-key setup.
- `Database.transaction(fn)` is the sole write boundary used by auth, submissions, moderation and publishing.
- Time is injected as epoch milliseconds in tests; rows map to public DTO only in services.

- [ ] **Step 1: Write failing migration tests against a real temporary SQLite file**

Cover first boot, repeat boot, every declared table, required indexes, foreign keys, WAL, `PRAGMA user_version = 1`, migration rollback and reopening a populated database.

- [ ] **Step 2: Run and observe missing migration failure**

Run: `cd packages/skill-market-server && bun test test/database.test.ts`

Expected: FAIL because `openDatabase` and migration SQL do not exist.

- [ ] **Step 3: Create the normalized schema and constraints**

Create `users`, `role_assignments`, `login_attempts`, `sessions`, `community_skills`, `submissions`, `submission_revisions`, `reviews`, `publish_jobs`, `audit_events`, plus a small `idempotency_keys` table required for 24-hour request replay. Store validation claim owner/lease/completion columns on `submission_revisions`. Enforce role/decision/status checks, unique revision numbers, one active version submission, foreign keys and useful queue/expiry indexes.

- [ ] **Step 4: Implement ordered migrations with exclusive startup semantics**

Read migration files via `Bun.file()`. When an existing database needs migration, first create a mode-0600 consistent SQLite backup under the configured local migration-backup directory and verify `integrity_check`; then run each migration in an exclusive transaction, set `user_version` only after its statements succeed, and close the database on failure. Default database path is `/var/lib/ruying-skill-market/market.db`; tests inject temporary database and backup paths.

- [ ] **Step 5: Add config parsing and bootstrap limits**

Parse database path, private OSS prefix, web Origin, SSO URLs, cookie mode, bootstrap Admin IDs, session durations, upload daily limit and active submission limit. Reject a private prefix nested below the public prefix and reject insecure Cookie mode unless the explicit IP-test flag is true.

- [ ] **Step 6: Run tests/typecheck and commit**

```bash
cd packages/skill-market-server
bun test test/database.test.ts test/sources.test.ts
bun typecheck
git add migrations src/database.ts src/config.ts package.json test/database.test.ts test/sources.test.ts
git commit -m "feat(skill-market): add control database"
```

### Task 4: Implement SSO attempts, sessions, cookies, and RBAC security

**Files:**
- Create: `packages/skill-market-server/src/auth.ts`
- Create: `packages/skill-market-server/src/security.ts`
- Create: `packages/skill-market-server/test/auth.test.ts`
- Create: `packages/skill-market-server/test/security.test.ts`
- Reference: `packages/opencode/src/plugin/ruying.ts`

**Interfaces:**
- `Auth.begin(returnTo)` returns an SSO URL and stores a one-time hashed attempt.
- `Auth.complete(attemptID, token)` calls the existing provisioning endpoint, parses trusted `tokenName`, discards all remote credentials, upserts the user and creates a hashed session/CSRF pair.
- `Security.requireSession`, `requireReviewer`, `requireAdmin`, `requireWriteProtection` return typed principals or stable errors.

- [ ] **Step 1: Write failing tests with a real local HTTP provisioning server**

Cover valid login, unknown/expired/replayed attempt, off-site `returnTo`, provisioning rejection, disabled user, malformed `tokenName`, discarded AI key, hashed session/CSRF storage, logout, 12-hour absolute expiry and 2-hour idle expiry.

- [ ] **Step 2: Add a permission matrix test**

Assert Submitter can access only own records, Reviewer sees the queue and cannot self-review, Admin can manage roles, disabled users cannot create a session, and role checks never trust client-provided employee IDs.

- [ ] **Step 3: Implement one-time TOKEN-mode login**

Use the existing `mode=TOKEN` SSO flow and 256-bit random attempt/session/CSRF values. Store only SHA-256 hashes, compare hashes in constant time, and allow return paths matching only `/skills`, `/skills/:source/:id`, `/submissions`, `/submissions/new`, `/submissions/:id`, `/admin`, `/admin/submissions/:id`, `/admin/roles` and `/admin/audit`. Parse employee ID/display name using the already deployed Ruying tokenName convention. Never persist the callback token or provisioning response key.

- [ ] **Step 4: Implement Cookie policy and session refresh rules**

Production cookie: `__Host-ruying_market_session; Secure; HttpOnly; SameSite=Lax; Path=/`. IP test cookie: `ruying_market_session; HttpOnly; SameSite=Lax; Path=/`, enabled only by config. Update `last_activity_at` at most once every five minutes while checking both idle and absolute expiry.

- [ ] **Step 5: Implement bootstrap Admin and role authorization**

In one transaction, seed configured employee IDs only when no Admin exists and append `bootstrap-admin` audit events. Protect the final Admin from deletion. Treat Admin as Reviewer for decisions but require Admin for roles, audit, retry, delist and restore.

- [ ] **Step 6: Test, typecheck, and commit**

```bash
cd packages/skill-market-server
bun test test/auth.test.ts test/security.test.ts
bun typecheck
git add src/auth.ts src/security.ts test/auth.test.ts test/security.test.ts
git commit -m "feat(skill-market): add sso authorization"
```

### Task 5: Stream uploads into quarantine and validate archives without execution

**Files:**
- Create: `packages/skill-market-server/src/submission-archive.ts`
- Create: `packages/skill-market-server/src/scanner.ts`
- Modify: `packages/skill-market-server/src/oss.ts`
- Create: `packages/skill-market-server/test/submission-archive.test.ts`
- Create: `packages/skill-market-server/test/scanner.test.ts`
- Modify: `packages/skill-market-server/test/zip.ts`

**Interfaces:**
- `receiveSubmission(parts, context)` streams package/icon objects to a request-scoped private key while hashing and enforcing compressed limits.
- `validateSubmissionArchive(bytesOrReader, metadata)` returns a canonical manifest, cleaned README, metadata and scan report; it never evaluates content.
- `ObjectStore` gains immutable private put/copy/delete and metadata-aware HEAD methods needed by quarantine/publishing.

- [ ] **Step 1: Add failing real-ZIP fixtures and table-driven structural tests**

Cover valid ZIP, 50 MiB compressed limit, 200 MiB expanded limit, 2,000 file limit, 100:1 ratio, absolute/traversal/empty/duplicate paths, symlink/hardlink, ZIP64, encrypted entries, local/central filename mismatch, multiple/missing root `SKILL.md`, unsafe ID and corrupt data.

- [ ] **Step 2: Add failing static scan and icon tests**

Cover executable/native/script detection, redacted secret match, dangerous command/network/persistence patterns, HTML event attributes, dangerous protocols, PNG/JPEG/WebP decode, safe SVG allowlist, scripted SVG and the 1 MiB icon limit.

- [ ] **Step 3: Extract and generalize existing ZIP verification safely**

Reuse the proven central-directory checks from `src/sync.ts`, parameterize limits for upstream versus user uploads, and keep full-file content only for bounded `SKILL.md`/README/scanning. The HTTP upload path must stream to private OSS first instead of calling `request.arrayBuffer()`.

- [ ] **Step 4: Produce canonical validation artifacts**

Write `package.zip`, `manifest.json` and `scan.json` beneath:

```text
<private-prefix>/submissions/<sha256(employee-id)>/<submission-id>/<revision>/
```

The manifest contains package/file SHA-256, size, MIME and paths. Scan evidence contains redacted rule summaries and locations only. A structural violation or likely valid credential yields `validation_failed`; ordinary script/danger patterns yield `warning` or `danger` for review.

- [ ] **Step 5: Ensure cleanup and log redaction on every failed path**

On multipart failure, delete request-scoped partial objects; on validation failure retain the complete quarantine package for 30-day policy but never expose its key. Add a logger assertion that the marker secret and private key are absent.

- [ ] **Step 6: Run focused tests/typecheck and commit**

```bash
cd packages/skill-market-server
bun test test/submission-archive.test.ts test/scanner.test.ts test/oss.test.ts test/sync.test.ts
bun typecheck
git add src/submission-archive.ts src/scanner.ts src/oss.ts src/sync.ts test
git commit -m "feat(skill-market): validate submitted archives"
```

### Task 6: Implement submission ownership, idempotency, limits, and state transitions

**Files:**
- Create: `packages/skill-market-server/src/submissions.ts`
- Create: `packages/skill-market-server/test/submissions.test.ts`
- Modify: `packages/skill-market-server/src/database.ts`

**Interfaces:**
- `Submissions.listOwn`, `getOwn`, `create`, `addRevision`, `completeValidation`.
- A single pure transition table validates every state change before transactional persistence.
- `create` and `addRevision` require a 24-hour idempotency key scoped by employee and route.

- [ ] **Step 1: Write a table-driven failing state-machine test**

Test every allowed edge from the approved diagram and reject skip, duplicate and terminal transitions. Verify `published` is immutable and a new version creates a new submission.

- [ ] **Step 2: Write failing ownership, SemVer, quota, and idempotency tests**

Cover permanent first-publisher ownership, conflicting employee, strictly increasing canonical SemVer, at most five active submissions, 20 upload attempts/day, replay returning the same response, and same idempotency key with a different payload returning conflict.

- [ ] **Step 3: Implement the happy-path service and isolate validation completion**

Create a `validating` row and revision in one transaction, enqueue validation after commit, then transition to `pending_review` or `validation_failed` in a second transaction with an audit event. Upload revision numbers and optimistic `version` both increment monotonically.

- [ ] **Step 4: Enforce immutable ownership and version rules transactionally**

Lock by SQLite immediate transaction, re-read `community_skills`/active submissions, reject ownership and SemVer races, and store stable error codes. Do not use a client-provided owner or current public version.

- [ ] **Step 5: Verify status, revision, and audit are atomic**

Inject a failure between writes and assert no partial state persists. Verify users can never list/read another employee's private submission.

- [ ] **Step 6: Test, typecheck, and commit**

```bash
cd packages/skill-market-server
bun test test/submissions.test.ts test/database.test.ts
bun typecheck
git add src/submissions.ts src/database.ts test/submissions.test.ts
git commit -m "feat(skill-market): manage submission lifecycle"
```

### Task 7: Implement moderation, role administration, audit, and community visibility

**Files:**
- Create: `packages/skill-market-server/src/moderation.ts`
- Create: `packages/skill-market-server/test/moderation.test.ts`
- Modify: `packages/skill-market-server/src/database.ts`

**Interfaces:**
- `Moderation.listQueue`, `get`, `decide`, `retryPublish`, `assignRole`, `removeRole`, `listAudit`, `delist`, `restore`.
- Decisions require the current submission concurrency version and create an append-only review plus audit event in the same transaction.

- [ ] **Step 1: Write failing concurrent-review and self-review tests**

Run two Reviewer decisions concurrently; exactly one succeeds and the other returns `submission-conflict`. Reject an employee reviewing their own submission even if they are Admin.

- [ ] **Step 2: Write failing decision validation tests**

Require comments for `request_changes` and `reject`; require explicit risk summary confirmation to approve `warning` or `danger`; allow approve only from `pending_review`; never echo secret scan evidence.

- [ ] **Step 3: Implement decisions and atomic audit records**

`approve` changes status to `publishing` and inserts one pending publish job. Other decisions move to their exact target states. Store previous/new state summaries, reviewer identity and request ID without mutable audit update/delete methods.

- [ ] **Step 4: Implement role and account administration**

Only Admin may add/remove Reviewer/Admin roles; reject deletion of the last Admin; audit every change. User disable/enable remains distinct from roles and public listing state.

- [ ] **Step 5: Implement delist/restore and retry guards**

Only Admin can act; require optimistic version, reason and current valid state. Delist changes `community_skills.public_status` and enqueues a catalog rebuild without deleting packages. Retry is accepted only for `publish_failed` and creates no duplicate active job.

- [ ] **Step 6: Run tests/typecheck and commit**

```bash
cd packages/skill-market-server
bun test test/moderation.test.ts test/security.test.ts
bun typecheck
git add src/moderation.ts src/database.ts test/moderation.test.ts
git commit -m "feat(skill-market): add submission moderation"
```

### Task 8: Materialize community skills and merge all three catalog sources

**Files:**
- Create: `packages/skill-market-server/src/community.ts`
- Modify: `packages/skill-market-server/src/catalog.ts`
- Modify: `packages/skill-market-server/src/sync.ts`
- Modify: `packages/skill-market-server/test/catalog.test.ts`
- Create: `packages/skill-market-server/test/community.test.ts`

**Interfaces:**
- `Community.listPublished(database)` produces verified `SkillMarket.Detail[]` from published rows and immutable objects.
- `mergeCatalog` consumes SkillHub, enterprise and community details without dropping a healthy source when another source is stale.

- [ ] **Step 1: Write failing three-source catalog tests**

Assert community items appear in facets/search/detail/download, source status has three keys, delisted community items disappear, author/reviewer fields decode, and SkillHub/enterprise behavior is unchanged.

- [ ] **Step 2: Write failing community materialization tests**

Verify source is `community`, public URL is `/skills/community/:id`, versions preserve history, old version remains current while a newer submission is pending, and only a published database row can become public.

- [ ] **Step 3: Build immutable public community objects**

Copy the approved package to:

```text
<public-prefix>/packages/community/<skill-id>/<version>/<sha256>.zip
```

Copy a valid icon to `assets/icons/<sha256>.<ext>`, HEAD-check size and hash metadata, and build the detail from stored canonical metadata/manifest rather than reparsing untrusted form input.

- [ ] **Step 4: Update catalog merge and status propagation**

Add `community` branches to all exhaustive source checks and derive its status from database/publisher availability. Prevent duplicate `source:id` keys; source names can share IDs safely because keys include source.

- [ ] **Step 5: Run catalog/community regression tests**

```bash
cd packages/skill-market-server
bun test test/community.test.ts test/catalog.test.ts test/http.test.ts test/performance.test.ts
bun typecheck
```

- [ ] **Step 6: Commit the public community source**

```bash
git add src/community.ts src/catalog.ts src/sync.ts test/community.test.ts test/catalog.test.ts test/http.test.ts
git commit -m "feat(skill-market): publish community catalog"
```

### Task 9: Add leased publish jobs and crash reconciliation

**Files:**
- Create: `packages/skill-market-server/src/publisher.ts`
- Create: `packages/skill-market-server/test/publisher.test.ts`
- Modify: `packages/skill-market-server/src/oss.ts`
- Modify: `packages/skill-market-server/src/sync.ts`

**Interfaces:**
- `Publisher.runOne(workerID)` leases one job, publishes/rebuilds, and completes it idempotently.
- `Publisher.recover()` reconciles expired leases and a pointer already moved before database completion.
- All pointer writers use the same SQLite lease boundary.

- [ ] **Step 1: Write failing lease and idempotency tests**

Cover two workers, one winner, lease expiry, repeated same job/hash, OSS copy retry, HEAD mismatch, target revision stored before pointer update and one active job per submission.

- [ ] **Step 2: Write explicit crash-point tests**

Inject crashes after immutable package copy, after snapshot objects, after target revision persistence, after `current.json`, and before final DB commit. At every point, the old pointer remains usable or recovery completes exactly once.

- [ ] **Step 3: Implement the serialized pointer-update sequence**

The worker must execute in this order:

```text
lease job -> verify quarantine -> copy immutable package -> load all sources
-> build/validate snapshot -> write immutable snapshot -> persist target revision
-> update current.json -> finalize community/submission/job/audit transaction
```

- [ ] **Step 4: Reconcile pointer-ahead-of-database state**

If `current.json.revision` equals the job's stored target revision while DB status is `publishing`, update only SQLite state and audit. Do not republish or move the pointer. If the pointer differs, safely retry the immutable sequence.

- [ ] **Step 5: Make synchronization recover first and share the lease**

At the start of `src/sync.ts`, run recovery and drain eligible publish jobs before SkillHub/enterprise sync. Regular sync acquires the same catalog lease so it cannot overwrite a just-approved community snapshot with stale community rows.

- [ ] **Step 6: Test, typecheck, and commit**

```bash
cd packages/skill-market-server
bun test test/publisher.test.ts test/sync.test.ts test/oss.test.ts
bun typecheck
git add src/publisher.ts src/sync.ts src/oss.ts test/publisher.test.ts test/sync.test.ts test/oss.test.ts
git commit -m "feat(skill-market): recover catalog publishing"
```

### Task 10: Serve the typed control API with route-specific security

**Files:**
- Create: `packages/skill-market-server/src/http/catalog.ts`
- Create: `packages/skill-market-server/src/http/auth.ts`
- Create: `packages/skill-market-server/src/http/submissions.ts`
- Create: `packages/skill-market-server/src/http/admin.ts`
- Create: `packages/skill-market-server/src/http/middleware.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Modify: `packages/skill-market-server/test/http.test.ts`
- Create: `packages/skill-market-server/test/control-http.test.ts`

**Interfaces:**
- Each file provides one `HttpApiBuilder.group(SkillMarketApi, groupName, handlerBuilder)` layer.
- Middleware derives principal/request ID from headers/cookies and returns stable typed problems.
- Multipart handlers consume `Stream<Multipart.Part>` with Effect limits; no complete-body buffer.

- [ ] **Step 1: Expand HTTP tests before replacing the current raw handler**

Preserve existing catalog GET/HEAD/OPTIONS assertions. Add real-server tests for login/session/logout, cookies, credentialed Origin, preflight, CSRF, upload streaming, role rejection, malformed JSON/multipart, stable errors and no stack/private data leaks.

- [ ] **Step 2: Run focused HTTP tests and confirm missing endpoints**

Run: `cd packages/skill-market-server && bun test test/http.test.ts test/control-http.test.ts`

Expected: public tests PASS and control tests FAIL with 404.

- [ ] **Step 3: Implement group handlers and middleware layers**

Use `HttpApiBuilder.group` for typed decoding/encoding. Bind services to named variables inside Effect generators. Apply session middleware only to protected groups, Reviewer/Admin checks at the narrow endpoint boundary, and write protection (Origin + CSRF) to every state-changing endpoint including logout.

- [ ] **Step 4: Apply distinct CORS and security headers**

Public catalog responses keep wildcard CORS and only `GET, HEAD, OPTIONS`. Control responses use the exact configured Origin, `Access-Control-Allow-Credentials: true`, `Vary: Origin`, restrictive CSP, `frame-ancestors 'none'`, `nosniff`, no-store for auth/private data, and no credentialed wildcard.

- [ ] **Step 5: Replace `Bun.serve` with an Effect Node HTTP layer after migration**

Build the database/service layers first, run migrations/bootstrap synchronously inside the startup effect, then launch `HttpRouter.serve` through `NodeHttpServer.layerConfig`. Health reports process availability; readiness remains false while migration/recovery initialization is incomplete.

- [ ] **Step 6: Run HTTP regression and typecheck**

```bash
cd packages/skill-market-server
bun test test/http.test.ts test/control-http.test.ts test/auth.test.ts test/security.test.ts
bun typecheck
```

Expected: all tests PASS; a 51 MiB multipart request is rejected without proportional heap growth.

- [ ] **Step 7: Commit the HTTP server migration**

```bash
git add src/http src/handlers.ts src/server.ts test/http.test.ts test/control-http.test.ts
git commit -m "feat(skill-market): serve submission api"
```

### Task 11: Add asynchronous validation, metrics, cleanup hooks, and package documentation

**Files:**
- Create: `packages/skill-market-server/src/worker.ts`
- Create: `packages/skill-market-server/test/worker.test.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Modify: `packages/skill-market-server/src/sync.ts`
- Modify: `packages/skill-market-server/README.md`
- Modify: `packages/skill-market-server/package.json`

**Interfaces:**
- `worker.ts --once` drains validation and publication work; server also wakes it advisory-style after commits.
- Work remains durable in SQLite; process-local wakeups are optimization only.
- Structured metrics expose counts/durations without user or content data.

- [ ] **Step 1: Write failing restart and queue-drain tests**

Create work, close the process-owned services, reopen the same DB, run one drain, and assert validation/publishing resumes. Verify duplicate wakeups coalesce and different queued submissions can validate without duplicate transitions.

- [ ] **Step 2: Implement durable validation work discovery**

Treat `validating` revisions without a completed scan as eligible work and claim them using a bounded lease represented in SQLite. On success/failure, call `Submissions.completeValidation`; never depend on an in-memory queue for correctness.

- [ ] **Step 3: Emit safe structured metrics**

Emit upload counts, validation duration/result, review wait/decision, publish result, SSO result, session/role rejection, cleanup and DB backup hooks. Exclude names, employee IDs, paths and content hashes from metric labels.

- [ ] **Step 4: Document every required environment variable and command**

Document `start`, `worker --once`, `sync`, migration behavior, private/public prefixes, bootstrap IDs, session/Cookie flags and IP-test limitations. Include a redacted `.env` example with no real credentials.

- [ ] **Step 5: Run worker and complete package tests**

```bash
cd packages/skill-market-server
bun test
bun typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit worker/docs**

```bash
git add src/worker.ts src/server.ts src/sync.ts test/worker.test.ts README.md package.json
git commit -m "feat(skill-market): operate submission workers"
```

### Task 12: Run backend integration and generated-client verification

**Files:**
- Verify: `packages/schema/`
- Verify: `packages/protocol/`
- Verify: `packages/client/`
- Verify: `packages/skill-market-server/`

- [ ] **Step 1: Run the complete backend verification suite**

```bash
cd packages/schema && bun test && bun typecheck
cd ../protocol && bun test && bun typecheck
cd ../client && bun run generate && git diff --exit-code -- src/generated src/generated-effect && bun typecheck
cd ../skill-market-server && bun test && bun typecheck
```

Expected: every command exits 0; client regeneration produces no uncommitted diff.

- [ ] **Step 2: Run security-focused searches**

```bash
rg -n "request\.arrayBuffer\(\)|console\.(log|info).*token|AccessKey|Secret|TO[D]O|FIXM[E]" packages/skill-market-server/src
```

Expected: no whole-request upload buffering, credential logging, embedded AK/SK or placeholder marker remains. Any legitimate unrelated match is inspected and recorded in the implementation handoff.

- [ ] **Step 3: Run diff hygiene checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended source/generated/test/docs files plus the user's pre-existing untracked directories are present.

- [ ] **Step 4: Record backend acceptance evidence**

Capture exact commands and results for: one-time SSO replay rejection, CSRF/Origin rejection, valid 202 upload, invalid ZIP quarantine, concurrent Reviewer conflict, self-review rejection, pointer-before/after failure behavior and restart reconciliation. Do not capture tokens, cookies, employee IDs or private OSS keys.
