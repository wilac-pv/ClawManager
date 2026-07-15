# Ruying Skill Market Submission Web and Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Skill 市场 Web 中提供完整的登录投稿中心和 Reviewer/Admin 后台，为公共市场增加“用户投稿”来源，并在桌面端提供安全的外部浏览器投稿入口。

**Architecture:** `skill-market-web` 继续复用 App 包中的公共市场组件，同时新增只属于 Web 的会话、投稿和管理页面。控制 API 数据源使用 `credentials: include`、Schema 解码、会话 CSRF 和幂等键；路由守卫根据服务端会话角色显示功能，绝不把授权建立在客户端隐藏按钮上。桌面端只向共享列表传入安全外链动作，不读取或上传本地文件。

**Tech Stack:** SolidJS、`@solidjs/router`、TanStack Solid Query、Effect Schema、Vite、Bun test、Playwright。

## Global Constraints

- 后端计划 `2026-07-15-ruying-skill-market-submission-backend.md` 的 Schema/Protocol 和 API 必须先完成。
- Web 控制请求必须带 `credentials: "include"`；写请求必须带当前会话的 `X-CSRF-Token`，不存储会话 Cookie。
- 公开目录继续允许跨域匿名读取；投稿和管理 UI 不直接访问 OSS、不接触 AK/SK、不展示私有 OSS Key。
- 所有角色、所有权、状态和并发判断以服务端响应为准；路由守卫只是体验优化。
- 保持现有固定浅色视觉；桌面端不增加原生上传表单和文件读取。
- 所有深链支持刷新；SSO 返回路径只能是站内已知路由。
- 测试和 `bun typecheck` 从对应 package 目录运行。

---

## File Structure

- `packages/skill-market-web/src/control-data-source.ts`：带会话、CSRF、multipart 和稳定错误解码的控制 API 客户端。
- `packages/skill-market-web/src/session.tsx`：会话 Query、登录、退出和角色派生。
- `packages/skill-market-web/src/shell.tsx`：公共市场、我的投稿和管理后台导航。
- `packages/skill-market-web/src/submissions/`：投稿列表、ZIP 表单、详情、修订历史和状态时间线。
- `packages/skill-market-web/src/admin/`：审核队列、审核详情、角色和审计页面。
- `packages/skill-market-web/src/app.tsx`：完整公开/投稿/管理路由树和守卫。
- `packages/skill-market-web/src/styles.css`：Web 壳层、表单、表格、风险和响应式样式。
- `packages/app/src/skill-market/list.tsx`：共享市场“投稿 Skill”入口和用户投稿筛选。
- `packages/app/src/pages/skill-market.tsx`：接受 `community` 深链并由桌面平台安全打开 Web。
- `packages/app/src/skill-market/feature.ts`：校验投稿站点 URL 配置。
- `packages/skill-market-web/e2e/fixtures/server.ts`：有状态身份/投稿/审核测试服务。

### Task 1: Add the credentialed control API data source

**Files:**
- Create: `packages/skill-market-web/src/control-data-source.ts`
- Create: `packages/skill-market-web/src/control-data-source.test.ts`
- Modify: `packages/skill-market-web/src/env.d.ts`
- Modify: `packages/skill-market-web/package.json`

**Interfaces:**
- `createSkillMarketControlDataSource(baseUrl, options)` exposes session, submissions, moderation, roles and audit methods.
- Every response is decoded with `SkillMarketControl` schemas; non-2xx responses decode `Problem` and throw `MarketControlError`.
- `create`/`revise` accept `File`, metadata and an idempotency key; they build `FormData` without reading the ZIP into JavaScript memory.

- [ ] **Step 1: Write failing data-source tests with a local Bun server**

Assert GET requests include credentials, writes include credentials/Origin-managed cookies/CSRF/idempotency header, multipart contains package/icon/metadata, abort signals propagate, `409` preserves stable code/request ID, and malformed success/error payloads fail closed.

- [ ] **Step 2: Run the focused test and verify the missing module**

Run: `cd packages/skill-market-web && bun test src/control-data-source.test.ts`

Expected: FAIL because the control data source does not exist.

- [ ] **Step 3: Implement one generic decoded request boundary**

Keep URL safety consistent with the existing catalog data source: HTTPS outside loopback, or private IPv4 HTTP only under `VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP=true`. Always set `accept: application/json`; set `content-type` only for JSON, never manually for `FormData`.

- [ ] **Step 4: Implement session-bound write requests**

Require a CSRF value supplied by the session provider before issuing POST/DELETE. Generate `crypto.randomUUID()` idempotency keys in the calling mutation and retain them through retries; do not generate a new key inside the fetch retry.

- [ ] **Step 5: Run unit tests/typecheck and commit**

```bash
cd packages/skill-market-web
bun test src/data-source.test.ts src/control-data-source.test.ts
bun typecheck
git add src/control-data-source.ts src/control-data-source.test.ts src/env.d.ts package.json
git commit -m "feat(skill-market-web): add control client"
```

### Task 2: Add the session provider, SSO handoff, and protected shell

**Files:**
- Create: `packages/skill-market-web/src/session.tsx`
- Create: `packages/skill-market-web/src/session.test.tsx`
- Create: `packages/skill-market-web/src/shell.tsx`
- Create: `packages/skill-market-web/src/shell.test.tsx`
- Modify: `packages/skill-market-web/src/app.tsx`

**Interfaces:**
- `SkillMarketSessionProvider` owns the current session query and login/logout mutations.
- `RequireSession`, `RequireReviewer`, `RequireAdmin` render loading, redirect or forbidden states.
- `MarketShell` shows 市场 / 我的投稿 / 管理后台 based on server-returned roles.

- [ ] **Step 1: Write failing component tests for anonymous and role states**

Cover anonymous public market, login redirect preserving `/submissions/new`, Submitter without admin navigation, Reviewer with review navigation, Admin with role/audit navigation, session expiry and logout.

- [ ] **Step 2: Run and verify missing session/shell modules**

Run: `cd packages/skill-market-web && bun test src/session.test.tsx src/shell.test.tsx`

Expected: FAIL because providers/components are absent.

- [ ] **Step 3: Implement SSO login as a full-page navigation**

Validate the current path against the known internal route list, then use `window.location.assign` on the market API's `/v1/auth/login?returnTo=<encoded internal path>` endpoint. That endpoint creates the attempt and responds with a redirect to GWM SSO; the callback is server-owned. After redirect back, refetch `/v1/auth/session`. Do not fetch the SSO URL with XHR, use a popup, or put tokens in Web state/storage.

- [ ] **Step 4: Implement route guards and a keyboard-accessible shell**

Show a short loading state while the session query resolves. Anonymous protected routes display one primary “使用 GWM SSO 登录” action. Forbidden role routes display a 403 state with a link back to `/skills`. Use semantic nav links, visible focus, current-route state and a compact employee name/ID layout that does not crowd.

- [ ] **Step 5: Wire the route tree without adding feature pages yet**

Register exact paths `/skills`, `/skills/:source/:id`, `/submissions`, `/submissions/new`, `/submissions/:id`, `/admin`, `/admin/submissions/:id`, `/admin/roles`, `/admin/audit`. Unknown routes redirect to `/skills`; protected placeholders are replaced in later tasks.

- [ ] **Step 6: Test, typecheck, and commit**

```bash
cd packages/skill-market-web
bun test src/session.test.tsx src/shell.test.tsx
bun typecheck
git add src/session.tsx src/session.test.tsx src/shell.tsx src/shell.test.tsx src/app.tsx
git commit -m "feat(skill-market-web): add sso shell"
```

### Task 3: Build the submission list and ZIP upload flow

**Files:**
- Create: `packages/skill-market-web/src/submissions/list.tsx`
- Create: `packages/skill-market-web/src/submissions/list.test.tsx`
- Create: `packages/skill-market-web/src/submissions/form.tsx`
- Create: `packages/skill-market-web/src/submissions/form.test.tsx`
- Modify: `packages/skill-market-web/src/app.tsx`
- Modify: `packages/skill-market-web/src/styles.css`

**Interfaces:**
- `SubmissionList` queries only the signed-in user's page and filters by stable statuses.
- `SubmissionForm` supports first submission, new revision and new version modes from one component.
- A successful upload receives `202`, navigates to detail and polls boundedly while status is `validating`/`publishing`.

- [ ] **Step 1: Write failing list tests**

Cover empty state, filter counts, pending/changes/published/rejected/publish-failed labels, pagination, “投稿 Skill”, “提交新版本”, and no rendering of another user's data fixture.

- [ ] **Step 2: Write failing accessible form tests**

Cover ZIP required, `.zip` accept hint, 50 MiB client precheck, optional 1 MiB image precheck, SemVer, required display name/description/category/change notes, tags, license, API Key flag, submit disable/progress, error focus and idempotent retry.

- [ ] **Step 3: Implement the list with server status as source of truth**

Use query-string filters so back/refresh preserve the view. Map every stable status explicitly; do not collapse `validation_failed`, `changes_requested` and `publish_failed` into a generic error.

- [ ] **Step 4: Implement multipart submission without file buffering**

Append the browser `File` directly to `FormData`; serialize only bounded metadata JSON. The client precheck improves feedback but the server remains authoritative. Keep the same mutation idempotency key after network errors until a definitive response or form edit occurs.

- [ ] **Step 5: Add responsive fixed-light form/list styles**

Desktop uses a two-column metadata/file layout; narrow screens collapse to one column. Provide visible labels, descriptions, error association, focus outlines, sufficient contrast and reduced-motion support.

- [ ] **Step 6: Run focused tests/typecheck and commit**

```bash
cd packages/skill-market-web
bun test src/submissions/list.test.tsx src/submissions/form.test.tsx
bun typecheck
git add src/submissions src/app.tsx src/styles.css
git commit -m "feat(skill-market-web): add skill submissions"
```

### Task 4: Build submission detail, validation report, and revision history

**Files:**
- Create: `packages/skill-market-web/src/submissions/detail.tsx`
- Create: `packages/skill-market-web/src/submissions/detail.test.tsx`
- Create: `packages/skill-market-web/src/submissions/status.tsx`
- Modify: `packages/skill-market-web/src/submissions/form.tsx`
- Modify: `packages/skill-market-web/src/app.tsx`

**Interfaces:**
- `SubmissionDetail` displays canonical metadata, validation/scan, review history, revision history, status timeline and current public version.
- Actions are derived from status: revise after validation failure/changes request; create new submission after rejection; new version after published; no mutation on terminal read-only history.

- [ ] **Step 1: Write failing detail tests for every state**

Assert correct heading/actions/message for all eight statuses, structured validation issues, redacted scan evidence, review comments, concurrency refresh, published public link and publish failure retry visibility only for Admin.

- [ ] **Step 2: Implement a stable status/timeline component**

Use ordered events from the API rather than inferring timestamps. Announce status changes with a polite live region while polling, stop polling at non-working states, and show a manual refresh button after repeated network errors.

- [ ] **Step 3: Render safe reports and history**

Display cleaned Markdown through the existing market markdown component; render file paths as text, never HTML. Risk evidence shows rule/path/line/redacted summary. Do not add a direct private ZIP URL or preview untrusted HTML.

- [ ] **Step 4: Reuse the form for revisions and versions**

For `changes_requested`/`validation_failed`, POST to the current submission revisions endpoint with `expectedVersion`. For published version upgrades, prefill metadata but POST a new submission. On `submission-conflict`, refetch and preserve selected local files until the user chooses to retry.

- [ ] **Step 5: Test, typecheck, and commit**

```bash
cd packages/skill-market-web
bun test src/submissions/detail.test.tsx src/submissions/form.test.tsx
bun typecheck
git add src/submissions src/app.tsx
git commit -m "feat(skill-market-web): show submission history"
```

### Task 5: Build the Reviewer queue and review detail

**Files:**
- Create: `packages/skill-market-web/src/admin/queue.tsx`
- Create: `packages/skill-market-web/src/admin/queue.test.tsx`
- Create: `packages/skill-market-web/src/admin/review.tsx`
- Create: `packages/skill-market-web/src/admin/review.test.tsx`
- Modify: `packages/skill-market-web/src/app.tsx`
- Modify: `packages/skill-market-web/src/styles.css`

**Interfaces:**
- Queue filters by risk, status, submitter and time while preserving query parameters.
- Review page shows identity, metadata, cleaned README, version diff, manifest, static scan and review history.
- Decision mutation always sends the last loaded `expectedVersion` and refetches on conflict.

- [ ] **Step 1: Write failing Reviewer queue tests**

Cover counts, filters, pagination, stable risk/status labels, oldest-first waiting display, empty/loading/error states and route guard behavior.

- [ ] **Step 2: Write failing decision-panel tests**

Cover approve/request changes/reject, mandatory comments, self-review disabled with explanation, warning/danger second confirmation containing risk summary, double-click prevention and concurrent conflict refresh.

- [ ] **Step 3: Implement dense but readable review information**

Use sections/tabs for overview, cleaned README, version/metadata diff, files, scan and history. File lists use virtualization or pagination for up to 2,000 entries. Risk levels are conveyed by text/icon as well as color.

- [ ] **Step 4: Implement decision mutations safely**

Require typed confirmation, retain the same mutation payload during network retry, invalidate queue/detail/catalog queries after success, and route to the next pending item only after the server confirms the decision.

- [ ] **Step 5: Run tests/typecheck and commit**

```bash
cd packages/skill-market-web
bun test src/admin/queue.test.tsx src/admin/review.test.tsx
bun typecheck
git add src/admin src/app.tsx src/styles.css
git commit -m "feat(skill-market-web): add review workflow"
```

### Task 6: Build Admin roles, audit, retry, delist, and restore

**Files:**
- Create: `packages/skill-market-web/src/admin/roles.tsx`
- Create: `packages/skill-market-web/src/admin/roles.test.tsx`
- Create: `packages/skill-market-web/src/admin/audit.tsx`
- Create: `packages/skill-market-web/src/admin/audit.test.tsx`
- Modify: `packages/skill-market-web/src/admin/review.tsx`
- Modify: `packages/skill-market-web/src/app.tsx`

**Interfaces:**
- Roles page adds/removes Reviewer/Admin by employee ID and displays server-resolved identity.
- Audit page is read-only and filterable; no delete/edit/export-with-secrets action.
- Admin-only actions require a reason and use optimistic concurrency.

- [ ] **Step 1: Write failing role administration tests**

Cover add Reviewer/Admin, duplicate assignment, removal confirmation, last Admin rejection, non-Admin 403, disabled user state and query invalidation.

- [ ] **Step 2: Write failing audit and operational action tests**

Cover actor/action/object/time filters, pagination, redacted before/after summaries, publish retry, delist/restore reason, conflict refresh and absence of private keys/token material.

- [ ] **Step 3: Implement roles with server-authoritative errors**

Do not infer employee names or whether an Admin is last. Submit employee ID + role, then render the returned assignment. Keep final-Admin and duplicate errors visible next to the attempted row.

- [ ] **Step 4: Implement immutable audit viewing and operational confirmations**

Render request ID as a support correlation value. Require typed reason text for delist/restore and a confirmation dialog explaining that delist removes public visibility but retains packages/history.

- [ ] **Step 5: Test, typecheck, and commit**

```bash
cd packages/skill-market-web
bun test src/admin/roles.test.tsx src/admin/audit.test.tsx src/admin/review.test.tsx
bun typecheck
git add src/admin src/app.tsx
git commit -m "feat(skill-market-web): add admin controls"
```

### Task 7: Expose community catalog UX and the desktop external submission link

**Files:**
- Modify: `packages/app/src/skill-market/list.tsx`
- Modify: `packages/app/src/skill-market/list.test.tsx`
- Modify: `packages/app/src/skill-market/detail.tsx`
- Modify: `packages/app/src/pages/skill-market.tsx`
- Modify: `packages/app/src/pages/skill-market.test.tsx`
- Modify: `packages/app/src/skill-market/feature.ts`
- Modify: `packages/app/src/skill-market/index.ts`
- Modify: `packages/skill-market-web/src/app.tsx`
- Modify: `packages/skill-market-web/e2e/fixtures/catalog.ts`

**Interfaces:**
- `SkillMarketList` gains optional `onSubmit` and an explicit `community` filter/tab labeled “用户投稿”.
- `parseSkillKey` accepts all three exact sources.
- `skillMarketSubmissionUrl` validates `VITE_RUYING_SKILL_MARKET_WEB_URL` and returns the `/submissions/new` URL.

- [ ] **Step 1: Write failing shared component tests**

Assert community cards/filter/deep links render in Web and desktop, the optional “投稿 Skill” button is absent without an action, and clicking it invokes the action once without touching file APIs.

- [ ] **Step 2: Write failing desktop route/security tests**

Assert `parseSkillKey("community", id)` succeeds, unknown sources fail, configured HTTPS/private-test URL is accepted under explicit flag, public HTTP is rejected, and desktop click calls `platform.openLink` with the exact Web submission URL.

- [ ] **Step 3: Implement the third source exhaustively**

Update source filters, source status checks, labels, deep-link parsers and catalog fixtures. Show submitted-by/reviewed-at information on community details without exposing employee ID unless the approved public DTO explicitly contains it.

- [ ] **Step 4: Add Web and desktop submission actions**

Web action navigates internally to `/submissions/new`. Desktop action uses `usePlatform().openLink()` after the validated build-time URL is constructed. Desktop does not call the control API and does not open a native file picker.

- [ ] **Step 5: Run App and Web regression tests/typechecks**

```bash
cd packages/app
bun test src/skill-market/list.test.tsx src/pages/skill-market.test.tsx
bun typecheck
cd ../skill-market-web
bun test
bun typecheck
```

- [ ] **Step 6: Commit public/desktop integration**

```bash
git add packages/app packages/skill-market-web/src/app.tsx packages/skill-market-web/e2e/fixtures/catalog.ts
git commit -m "feat(app): link skill submissions"
```

### Task 8: Expand stateful browser E2E and release verification

**Files:**
- Modify: `packages/skill-market-web/e2e/fixtures/server.ts`
- Modify: `packages/skill-market-web/e2e/fixtures/catalog.ts`
- Modify: `packages/skill-market-web/e2e/market.e2e.ts`
- Modify: `packages/skill-market-web/playwright.config.ts`
- Modify: `packages/skill-market-web/README.md`
- Modify: `packages/skill-market-web/script/release.test.ts`

- [ ] **Step 1: Turn the fixture into a deterministic stateful control API**

Model anonymous/Submitter/Reviewer/Admin sessions, CSRF, own submissions, validation outcome, revisions, concurrent versions, decisions, publish failure/retry, roles and audit. Reject cross-user reads and self-review in the fixture so E2E proves the UI handles real error shapes.

- [ ] **Step 2: Add end-to-end user journeys**

Cover SSO redirect return, valid ZIP upload, validation failure and revision, pending review, changes requested, rejected, approved/published, new version while old remains public, session expiry and deep-link refresh.

- [ ] **Step 3: Add end-to-end Reviewer/Admin journeys**

Cover risk confirmation, self-review rejection, concurrent conflict, publish retry, role add/remove/last-Admin protection, audit filters, delist/restore and forbidden routes.

- [ ] **Step 4: Add accessibility and responsive checks**

Run keyboard-only navigation through shell/form/decision dialog, verify focus returns after dialogs, assert status live regions, test 390 px and desktop widths, reduced motion, fixed light theme and no horizontal page overflow.

- [ ] **Step 5: Verify the release preserves every SPA deep-link fallback**

Extend release tests so `/submissions`, `/submissions/:id`, `/admin`, `/admin/submissions/:id`, `/admin/roles` and `/admin/audit` all resolve to the immutable release `index.html`, not only `/skills/*`.

- [ ] **Step 6: Run complete Web/App verification**

```bash
cd packages/skill-market-web
bun test
bun typecheck
bun run build
bun run test:e2e
cd ../app
bun test src/skill-market
bun test src/pages/skill-market.test.tsx
bun typecheck
```

Expected: all commands exit 0; no browser console errors, failed network requests or accessibility failures are present in covered journeys.

- [ ] **Step 7: Run diff hygiene and commit E2E/docs**

```bash
git diff --check
git add packages/skill-market-web
git commit -m "test(skill-market-web): cover moderation flows"
```

### Task 9: Record UI acceptance evidence

**Files:**
- Verify: `packages/skill-market-web/`
- Verify: `packages/app/`

- [ ] **Step 1: Capture route and role acceptance results**

Record PASS/FAIL for every public, Submitter, Reviewer and Admin route, including direct refresh and session expiry. Use fixture identities only; do not capture real employee information.

- [ ] **Step 2: Capture upload and decision acceptance results**

Record valid/invalid ZIP feedback, progress, idempotent retry, risk confirmation, concurrency conflict and publication states. Screenshots must not contain private paths, cookies, CSRF values or scan secret matches.

- [ ] **Step 3: Verify desktop remains link-only**

Search the desktop/App diff for `File`, attachment picker and control API imports in the submission integration. Expected: the desktop change only validates/builds the URL and invokes `platform.openLink`.

```bash
git diff -- packages/app | rg -n "openLink|submission|File|Picker|control"
```
