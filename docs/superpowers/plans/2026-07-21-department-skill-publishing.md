# Department Skill Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users publish Skills company-wide or to their SSO department while enforcing department visibility on list, search, detail, install, and download operations.

**Architecture:** Extend the trusted provisioning response with stable department identity and persist it on login. Company publications continue through the existing public catalog; department publications remain in private OSS and a database-backed private catalog that is merged only after server-side authorization. Catalog reads use an optional session: anonymous users see company content, same-department users also see their department, and admins may select any synchronized department.

**Tech Stack:** TypeScript, Bun, Effect Schema and HttpApi, SQLite, SolidJS, S3-compatible private OSS, GWM SSO provisioning, systemd/Nginx.

## Global Constraints

- Submission scope is exactly `company` or `department`.
- Ordinary users may target only their current SSO `departmentId`; administrators may target any synchronized department.
- Authorization uses stable department ID, never department display name and never a browser-supplied identity.
- Unauthorized department resources return `404` from list-derived direct reads, detail, versions, install metadata, and package endpoints.
- Search, facets, totals, sorting, and pagination run after visibility filtering.
- Historical SkillHub, enterprise, and community records migrate to `company`.
- Department packages and detail JSON never enter the public OSS prefix or public catalog pointer.
- A user without department identity may log in and use company scope but cannot access or publish department content.
- Run tests and `bun typecheck` from package directories, never the repository root.
- After changing public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`; never edit generated clients directly.

---

## External Provisioning Prerequisite

The deployed `/opt/claw-server/claw-server` is a stripped Go binary with no source on the target. Its successful `/api/provision/token` response must be released by the claw-server owner with these additional fields before department publishing can become usable:

```json
{
  "departmentId": "stable-department-id",
  "departmentName": "部门展示名称"
}
```

The market changes below are backward compatible: both fields absent means “no department”; exactly one field present or invalid values means a malformed dependency response. The market must not infer department from `tokenName`. Production acceptance includes a real SSO login proving both fields arrive; until that succeeds, the UI shows only company scope.

## File Structure

- `packages/skill-market-server/migrations/006_department_publishing.sql`: departments, user department, submission/publication scope, and private department catalog records.
- `packages/schema/src/skill-market-control.ts`: department, session identity, scope, submission, and department directory models.
- `packages/schema/src/skill-market.ts`: public visibility labels and scoped catalog query fields.
- `packages/skill-market-server/src/auth.ts`, `security.ts`: trusted department provisioning and authorization predicates.
- `packages/skill-market-server/src/departments.ts`: synchronized department directory and admin list.
- `packages/skill-market-server/src/submissions.ts`, `submission-read.ts`, `moderation.ts`: scope validation, persistence, review, and audit.
- `packages/skill-market-server/src/community.ts`, `publisher.ts`: public company publication versus private department publication.
- `packages/skill-market-server/src/department-catalog.ts`: database/private-OSS reads for authorized department content.
- `packages/skill-market-server/src/http/catalog.ts`, `handlers.ts`: optional-session catalog filtering and private package delivery.
- Protocol groups for submission, admin, and catalog query changes.
- `packages/skill-market-web` submission, review, session, market, and data-source components.
- Tests adjacent to every server and UI component above.

### Task 1: Add department and publication-scope schemas

**Files:**
- Modify: `packages/schema/src/skill-market-control.ts`
- Modify: `packages/schema/src/skill-market.ts`
- Modify: `packages/protocol/src/groups/skill-market-catalog.ts`
- Modify: `packages/protocol/src/groups/skill-market-admin.ts`
- Modify: `packages/protocol/test/skill-market-catalog.test.ts`
- Modify: `packages/protocol/test/skill-market-control.test.ts`

**Interfaces:**
- Produces: `SkillMarketControl.Department`, `PublicationScope`, department on `User`, scope on submissions, and department list endpoint.
- Produces: optional visibility metadata on market summaries/details and `visibility` / `department` catalog filters.

- [ ] **Step 1: Write failing schema and protocol tests**

Assert a department submission decodes only with a department, a company submission rejects a department, a user may omit department, and the admin route is registered as `GET /v1/admin/departments`.

```ts
expect(decodeScope({ scope: "department", department: { id: "D-1", name: "研发部" } })).toBeTruthy()
expect(() => decodeScope({ scope: "company", department: { id: "D-1", name: "研发部" } })).toThrow()
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd packages/protocol
bun test test/skill-market-catalog.test.ts test/skill-market-control.test.ts
```

Expected: FAIL because the types and route do not exist.

- [ ] **Step 3: Add exact schemas and query normalization**

Add:

```ts
export const DepartmentID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/))
export const Department = Schema.Struct({ id: DepartmentID, name: bounded(1, 120) })
export const PublicationScope = Schema.Literals(["company", "department"])
export const PublicationTarget = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("company") }),
  Schema.Struct({ scope: Schema.Literal("department"), department: Department }),
])
```

Add optional `department` to `User`; add `target: PublicationTarget` to submission summary/detail inputs rather than hiding it in free-form metadata. Add optional `visibility` and `department` to `SkillMarket.Summary`, treating absent legacy values as company in readers. Add query filters `visibility: all|company|department` and optional `departmentId` for admin requests.

- [ ] **Step 4: Run protocol tests and typecheck**

```bash
bun test test/skill-market-catalog.test.ts test/skill-market-control.test.ts
bun typecheck
```

Expected: PASS with the new route and discriminated publication target.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/skill-market-control.ts packages/schema/src/skill-market.ts packages/protocol/src/groups/skill-market-catalog.ts packages/protocol/src/groups/skill-market-admin.ts packages/protocol/test/skill-market-catalog.test.ts packages/protocol/test/skill-market-control.test.ts
git commit -m "feat(skill-market): define department scope"
```

### Task 2: Migrate durable department and private-catalog state

**Files:**
- Create: `packages/skill-market-server/migrations/006_department_publishing.sql`
- Modify: `packages/skill-market-server/test/database.test.ts`

**Interfaces:**
- Produces: departments directory, user department foreign key, scope columns on submissions/community skills, and private department catalog entries.

- [ ] **Step 1: Write failing v5-to-v6 migration tests**

Seed users, historical submissions, and a published community Skill. Upgrade and assert version `6`, all historical rows have `publication_scope = 'company'`, department IDs are null, and foreign-key/invariant violations fail.

```ts
expect(version).toBe(6)
expect(submission.publication_scope).toBe("company")
expect(skill.department_id).toBeNull()
expect(connection.query("PRAGMA foreign_key_check").all()).toEqual([])
```

- [ ] **Step 2: Run migration tests to verify failure**

```bash
cd packages/skill-market-server
bun test test/database.test.ts
```

Expected: FAIL at version `5` and missing columns.

- [ ] **Step 3: Add migration 006**

Create:

```sql
CREATE TABLE departments (
  department_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  CHECK (last_seen_at >= first_seen_at)
) STRICT;

ALTER TABLE users ADD COLUMN department_id TEXT REFERENCES departments(department_id);
ALTER TABLE submissions ADD COLUMN publication_scope TEXT NOT NULL DEFAULT 'company'
  CHECK (publication_scope IN ('company', 'department'));
ALTER TABLE submissions ADD COLUMN department_id TEXT REFERENCES departments(department_id);
ALTER TABLE community_skills ADD COLUMN publication_scope TEXT NOT NULL DEFAULT 'company'
  CHECK (publication_scope IN ('company', 'department'));
ALTER TABLE community_skills ADD COLUMN department_id TEXT REFERENCES departments(department_id);
```

Add triggers rejecting `department` without `department_id` and `company` with one. Add `department_catalog_entries` keyed by `(department_id, skill_id)` with validated summary/detail JSON, private package key/SHA/size, current version, and timestamps. Index department list/sort fields and submission scope.

- [ ] **Step 4: Run migration tests**

```bash
bun test test/database.test.ts
```

Expected: PASS including strict invariants, backup, rollback, and foreign keys.

- [ ] **Step 5: Commit**

```bash
git add migrations/006_department_publishing.sql test/database.test.ts
git commit -m "feat(skill-market): migrate department data"
```

### Task 3: Persist trusted SSO departments and expose sessions

**Files:**
- Modify: `packages/skill-market-server/src/auth.ts`
- Modify: `packages/skill-market-server/src/security.ts`
- Modify: `packages/skill-market-server/test/auth.test.ts`
- Modify: `packages/skill-market-server/test/security.test.ts`

**Interfaces:**
- Consumes: provisioning `departmentId` and `departmentName`.
- Produces: session user with optional `department`; departments are upserted on every successful login.

- [ ] **Step 1: Write failing provisioning and session tests**

Cover valid department login, absent fields, only-one-field malformed response, invalid ID/name, department rename, employee transfer, and a subsequent session returning the new department.

```ts
expect(completed.session.user.department).toEqual({ id: "D-1", name: "研发部" })
expect(transferred.session.user.department).toEqual({ id: "D-2", name: "平台部" })
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test test/auth.test.ts test/security.test.ts
```

Expected: FAIL because provisioning ignores department fields.

- [ ] **Step 3: Parse and upsert department identity**

Extend `ProvisioningIdentity` with optional department. Accept neither field or both valid fields; reject partial pairs. In the login transaction, upsert the directory before the user:

```sql
INSERT INTO departments (department_id, display_name, first_seen_at, last_seen_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(department_id) DO UPDATE SET
  display_name = excluded.display_name,
  last_seen_at = excluded.last_seen_at;
```

Set `users.department_id = excluded.department_id` on every login, including null when the trusted response has no department. Join departments in `requireSession` and expose `{ id, name }` only when both database values exist.

- [ ] **Step 4: Run auth/security tests**

```bash
bun test test/auth.test.ts test/security.test.ts
```

Expected: PASS for rename, transfer, missing, and malformed cases.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/security.ts test/auth.test.ts test/security.test.ts
git commit -m "feat(skill-market): sync sso departments"
```

### Task 4: Authorize and audit submission targets

**Files:**
- Create: `packages/skill-market-server/src/departments.ts`
- Create: `packages/skill-market-server/test/departments.test.ts`
- Modify: `packages/skill-market-server/src/submissions.ts`
- Modify: `packages/skill-market-server/src/submission-read.ts`
- Modify: `packages/skill-market-server/src/moderation.ts`
- Modify: `packages/skill-market-server/test/submissions.test.ts`
- Modify: `packages/skill-market-server/test/moderation.test.ts`

**Interfaces:**
- Produces: `requirePublicationTarget(principal, input)` and admin department directory list.
- Submission create/revise inputs consume the discriminated `PublicationTarget` from Task 1.

- [ ] **Step 1: Write failing authorization matrix tests**

Test ordinary company, ordinary own department, ordinary other department, no-department user, admin any synchronized department, unknown department, scope changes on revision, review detail display, and audit payloads.

```ts
expect(() => create(otherDepartment)).toThrow("department target is not allowed")
expect(create(ownDepartment).submission.department?.id).toBe("D-1")
expect(audit.after).toMatchObject({ scope: "department", departmentId: "D-1" })
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test test/departments.test.ts test/submissions.test.ts test/moderation.test.ts
```

Expected: FAIL because target authorization and persistence do not exist.

- [ ] **Step 3: Implement directory and target authorization**

Use this rule in one server function called by create and revise:

```ts
if (input.scope === "company") return { scope: "company" } as const
if (principal.session.roles.includes("admin")) return requireKnownDepartment(input.department.id)
if (principal.session.user.department?.id === input.department.id) return input
throw new SkillMarketSecurityError("forbidden", "department target is not allowed")
```

Persist scope/department on `submissions`, include it in reads and moderation, and record before/after scope in append-only audit events. A revision may change scope only through the normal review state machine.

- [ ] **Step 4: Run tests**

```bash
bun test test/departments.test.ts test/submissions.test.ts test/moderation.test.ts
```

Expected: PASS for the complete role/department matrix.

- [ ] **Step 5: Commit**

```bash
git add src/departments.ts src/submissions.ts src/submission-read.ts src/moderation.ts test/departments.test.ts test/submissions.test.ts test/moderation.test.ts
git commit -m "feat(skill-market): authorize department submissions"
```

### Task 5: Publish department artifacts only to private storage

**Files:**
- Modify: `packages/skill-market-server/src/community.ts`
- Modify: `packages/skill-market-server/src/publisher.ts`
- Modify: `packages/skill-market-server/src/package-reader.ts`
- Modify: `packages/skill-market-server/test/community.test.ts`
- Modify: `packages/skill-market-server/test/publisher.test.ts`
- Modify: `packages/skill-market-server/test/package-reader.test.ts`

**Interfaces:**
- Company target: existing public catalog and public package prefix.
- Department target: private prefix `department-published/<department-id>/...` plus `department_catalog_entries`; no public index entry.

- [ ] **Step 1: Write failing storage-boundary tests**

Approve one company and one department submission. Assert the company package/detail use the public prefix, while the department package/detail use only the private prefix and never appear in the public catalog index or public object list.

```ts
expect(publicIndex.items.some((item) => item.id === "department-only")).toBe(false)
expect(privateKeys).toContain(`private/department-published/D-1/packages/${sha}.zip`)
expect(publicKeys.some((key) => key.includes("department-only"))).toBe(false)
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test test/community.test.ts test/publisher.test.ts test/package-reader.test.ts
```

Expected: FAIL because every community publication currently uses the public pipeline.

- [ ] **Step 3: Split publication by scope**

For `company`, keep existing behavior and set explicit visibility metadata. For `department`, copy verified package/icon objects to the durable private department prefix, construct detail package/download URLs pointing to authenticated market API routes, store validated summary/detail JSON plus private package coordinates in `department_catalog_entries`, and finalize `community_skills` scope atomically. Never add the department entry to `createCatalogIndex`.

Use an encoded safe storage segment derived from the department ID and reject `.` / `..` path components. Preserve content-addressed SHA-256 names.

- [ ] **Step 4: Run publication tests**

```bash
bun test test/community.test.ts test/publisher.test.ts test/package-reader.test.ts
```

Expected: PASS; no department object exists under the public prefix.

- [ ] **Step 5: Commit**

```bash
git add src/community.ts src/publisher.ts src/package-reader.ts test/community.test.ts test/publisher.test.ts test/package-reader.test.ts
git commit -m "feat(skill-market): privately publish departments"
```

### Task 6: Merge only authorized department catalog data

**Files:**
- Create: `packages/skill-market-server/src/department-catalog.ts`
- Create: `packages/skill-market-server/test/department-catalog.test.ts`
- Modify: `packages/skill-market-server/src/catalog.ts`
- Modify: `packages/skill-market-server/src/catalog-reader.ts`
- Modify: `packages/skill-market-server/src/security.ts`
- Modify: `packages/skill-market-server/src/http/catalog.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/test/http.test.ts`

**Interfaces:**
- Produces: optional principal for catalog reads and `CatalogAccess { departmentID?: string; admin: boolean }`.
- Produces: authorized list/detail/versions/download/package reads with post-visibility facets and totals.

- [ ] **Step 1: Write the failing end-to-end authorization matrix**

Seed company, D-1, and D-2 records. Exercise anonymous, D-1, D-2, reviewer D-2, and admin sessions across list, query search, facets, detail, versions, download metadata, GET package, and HEAD package. Assert unauthorized direct reads are `404` and totals exclude hidden records.

```ts
expect((await list(d1)).items.map((item) => item.id)).toEqual(["company", "d1"])
expect((await list(d2)).total).toBe(2)
expect((await detail(d1, "d2")).status).toBe(404)
expect((await packageGet(d1, "d2")).status).toBe(404)
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun test test/department-catalog.test.ts test/http.test.ts
```

Expected: FAIL because catalog routes are anonymous/public and department data is unavailable.

- [ ] **Step 3: Implement optional-session access and private merge**

Read session cookies in catalog handlers and call a non-throwing security method that returns `undefined` for anonymous/expired sessions. Derive access from trusted session roles and department. Load only the allowed private department index, merge it with company items, then call the existing filter/sort/paginate functions.

Use explicit guards:

```ts
function canReadDepartment(access: CatalogAccess, departmentID: string) {
  return access.admin || access.departmentID === departmentID
}
```

For authenticated catalog responses set `cache-control: private, max-age=60` and `vary: Cookie`; anonymous company-only responses may remain public. Serve department packages from private OSS only after the same authorization check. Never return presigned private OSS URLs.

- [ ] **Step 4: Run HTTP and catalog tests**

```bash
bun test test/department-catalog.test.ts test/catalog.test.ts test/catalog-reader.test.ts test/http.test.ts
```

Expected: PASS for every list/direct-read/package case and cache header assertion.

- [ ] **Step 5: Commit**

```bash
git add src/department-catalog.ts src/catalog.ts src/catalog-reader.ts src/security.ts src/http/catalog.ts src/handlers.ts test/department-catalog.test.ts test/catalog.test.ts test/catalog-reader.test.ts test/http.test.ts
git commit -m "feat(skill-market): enforce department visibility"
```

### Task 7: Wire department APIs and regenerate clients

**Files:**
- Modify: `packages/protocol/src/groups/skill-market-submissions.ts`
- Modify: `packages/protocol/src/groups/skill-market-admin.ts`
- Modify: `packages/skill-market-server/src/http/submissions.ts`
- Modify: `packages/skill-market-server/src/http/admin.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Modify: `packages/skill-market-server/test/control-http.test.ts`
- Generated: `packages/client/src/generated/**`, `packages/client/src/generated-effect/**`

**Interfaces:**
- Produces multipart fields `publicationScope` and optional `departmentId` for submission writes.
- Produces admin-only `GET /v1/admin/departments`.

- [ ] **Step 1: Write failing HTTP tests**

Test create/revise multipart decoding, forged department rejection, admin directory listing, reviewer denial, unknown department rejection, and response payload scope.

- [ ] **Step 2: Run tests to verify failure**

```bash
cd packages/skill-market-server
bun test test/control-http.test.ts
```

Expected: FAIL because payload fields and endpoint are absent.

- [ ] **Step 3: Add HTTP handlers**

Decode exact fields:

```ts
const target = received.publicationScope === "department"
  ? { scope: "department" as const, department: { id: requireDepartmentID(received.departmentId), name: "resolved-server-side" } }
  : { scope: "company" as const }
```

Resolve the actual department name server-side before passing target to submissions. Add the admin directory handler through `departments.list(principal)` and map invalid/forbidden requests to existing structured control errors.

- [ ] **Step 4: Regenerate and run tests**

```bash
cd packages/client && bun run generate
cd ../protocol && bun test && bun typecheck
cd ../skill-market-server && bun test test/control-http.test.ts && bun typecheck
```

Expected: PASS and generated clients contain department fields and endpoint.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/client packages/skill-market-server/src packages/skill-market-server/test/control-http.test.ts
git commit -m "feat(skill-market): expose department controls"
```

### Task 8: Add submission and review UI

**Files:**
- Modify: `packages/skill-market-web/src/session.tsx`
- Modify: `packages/skill-market-web/src/shell.tsx`
- Modify: `packages/skill-market-web/src/control-data-source.ts`
- Modify: `packages/skill-market-web/src/submissions/form.tsx`
- Modify: `packages/skill-market-web/src/submissions/detail.tsx`
- Modify: reviewer submission components under `packages/skill-market-web/src/admin/`
- Modify corresponding `*.test.ts` and `*.test.tsx` files.

**Interfaces:**
- Consumes: session department, admin departments, and scoped submission APIs.
- Produces: company/my-department selection for users and synchronized-department selection for admins.

- [ ] **Step 1: Write failing UI tests**

Cover ordinary user with department, user without department, admin directory selection, revising an existing target, review display, scope change warning, and request serialization.

```tsx
expect(view.getByLabelText("我的部门（研发部）")).toBeEnabled()
expect(noDepartment.getByLabelText(/我的部门/)).toBeDisabled()
expect(admin.getByRole("option", { name: "平台部" })).toBeTruthy()
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd packages/skill-market-web
bun run test:unit
bun run test:browser
```

Expected: FAIL because form/session/review components lack department data.

- [ ] **Step 3: Implement accessible target controls**

Add a `fieldset` labeled `发布范围` with company and department radios. For ordinary users, display and submit only the trusted session department ID. For admins, load `/v1/admin/departments` and render a required select when department scope is active. Disable department choice with the exact message `SSO 暂未返回部门信息，请重新登录或联系管理员。` when absent.

Show target badges in submission list/detail and review pages. On revision, initialize the existing target and display a warning when it changes.

- [ ] **Step 4: Run UI tests and typecheck**

```bash
bun test
bun typecheck
```

Expected: PASS for ordinary, absent-department, and admin behavior.

- [ ] **Step 5: Commit**

```bash
git add packages/skill-market-web/src
git commit -m "feat(skill-market): select publication scope"
```

### Task 9: Add market filters, labels, and authenticated data access

**Files:**
- Modify: `packages/app/src/skill-market/types.ts`
- Modify: `packages/app/src/skill-market/list.tsx`
- Modify: `packages/app/src/skill-market/detail.tsx`
- Modify: `packages/app/src/skill-market/desktop-source.ts`
- Modify: `packages/app/src/skill-market/*.test.ts*`
- Modify: `packages/skill-market-web/src/app.tsx`
- Modify: `packages/skill-market-web/src/data-source.ts`
- Modify: `packages/skill-market-web/src/data-source.test.ts`

**Interfaces:**
- Produces filters `全部可见`, `全公司`, `我的部门`; admins additionally select synchronized departments.
- All Web catalog fetches use `credentials: "include"`; desktop anonymous access remains company-only.

- [ ] **Step 1: Write failing market UI/source tests**

Assert query serialization, credentials, URL history, department/company labels, admin filter, ordinary-user inability to select another department, and anonymous company-only results.

- [ ] **Step 2: Run tests to verify failure**

```bash
cd packages/app
bun test src/skill-market
```

Expected: FAIL because visibility filters and labels do not exist.

- [ ] **Step 3: Implement filters and badges**

Extend list state with `visibility`. Render company/department badges from server-provided summary data. `我的部门` sends `visibility=department` without trusting a client department ID; admin sends the chosen synchronized ID. Web fetch sets credentials include. Reset page to 1 whenever visibility changes.

- [ ] **Step 4: Run app tests and typecheck**

```bash
bun test src/skill-market
bun typecheck
```

Expected: PASS with stable URL/query behavior and labels.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/skill-market packages/skill-market-web/src/app.tsx
git commit -m "feat(skill-market): filter department skills"
```

### Task 10: End-to-end security verification and deployment

**Files:**
- Modify: `packages/skill-market-web/e2e/fixtures/server.ts`
- Modify: `packages/skill-market-web/e2e/market.e2e.ts`
- Modify: `packages/skill-market-server/README.md`
- Modify: `packages/skill-market-server/deploy/README.md`

**Interfaces:**
- Produces: verified market release ready to enable after provisioning dependency acceptance.

- [ ] **Step 1: Add failing browser journeys**

Add D-1 author publication, reviewer approval, D-1 market visibility/download, D-2 hidden search/direct URL/download, admin all-department filter, and employee transfer journeys.

- [ ] **Step 2: Run E2E to verify failure**

```bash
cd packages/skill-market-web
bun run test:e2e
```

Expected: FAIL before fixture/server/UI support is complete.

- [ ] **Step 3: Complete fixtures and operational documentation**

Add exact provisioning response examples, explain that department fields are optional only for backward-compatible login, document private department object prefix, backup inclusion, access logs without package bodies, and the production acceptance query that confirms at least one synchronized department.

- [ ] **Step 4: Run the full relevant suite and builds**

```bash
cd packages/schema && bun typecheck
cd ../protocol && bun test && bun typecheck
cd ../skill-market-server && bun test && bun typecheck && bun run build:release
cd ../app && bun test src/skill-market && bun typecheck
cd ../skill-market-web && bun test && bun typecheck && bun run test:e2e && bun run build && bun run release
```

Expected: all commands PASS.

- [ ] **Step 5: Commit verification**

```bash
git add packages/skill-market-web/e2e packages/skill-market-server/README.md packages/skill-market-server/deploy/README.md
git commit -m "test(skill-market): verify department isolation"
```

- [ ] **Step 6: Verify provisioning prerequisite on production**

Have the claw-server owner deploy the two response fields. Perform a real SSO login and query the authenticated session endpoint without printing tokens:

```bash
curl -fsS -b session.cookies http://127.0.0.1:4210/v1/auth/session
```

Expected: `user.department.id` and `user.department.name` are present and match the employee's SSO department. If absent, deploy market code with company behavior only and do not claim department publishing is active.

- [ ] **Step 7: Deploy market releases and run isolation smoke tests**

Transfer immutable API and Web releases to `root@10.246.13.226` over port `9922`, run migration 006 as `ruying-market`, atomically switch release links, restart API/Web, and verify health. Use two controlled test accounts from different departments plus an admin. Confirm D-2 gets `404` for D-1 detail, version, download metadata, package GET, and package HEAD; confirm no department package key exists under the public OSS prefix.

- [ ] **Step 8: Record deployment evidence**

Report the API git SHA, Web release ID, synchronized department count, test Skill ID, each access-matrix HTTP status, and whether claw-server provisioning fields passed. Do not record session cookies, SSO tokens, OSS credentials, or private package URLs.
