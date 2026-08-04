# Skill Market Scoped Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable cross-department groups plus department, multi-group, personal, and company publication audiences with consistent authorization from catalog listing through package installation.

**Architecture:** Keep the existing anonymous company catalog unchanged and merge a database-backed restricted catalog only for authenticated callers. Persist live group membership separately from reviewed publication targets, centralize restricted access decisions, keep private packages in private OSS, and issue 10-minute hashed installation grants for external installers.

**Tech Stack:** Bun, TypeScript, Effect HttpApi, Effect Schema, SQLite, SolidJS, TanStack Solid Query, Happy DOM, Playwright, private S3-compatible OSS.

## Global Constraints

- A submission has exactly one scope: `personal`, `groups`, `department`, or `company`; group scope may target multiple groups.
- Personal scanning success activates immediately; every non-personal scope requires manual review.
- Company catalog and package reads remain anonymous on the intranet; every restricted read requires SSO authorization.
- Department authorization uses trusted `departmentId`; group authorization uses live employee-ID membership.
- Unauthorized restricted reads return `404`; private responses use `Cache-Control: private, no-store`.
- Private package keys and permanent OSS URLs never enter responses, logs, or the public OSS prefix.
- After public Protocol changes, run `bun run generate` from `packages/client`; never edit generated clients directly.
- Run tests and `bun typecheck` from package directories, never the repository root.
- Keep runtime dependencies directed Schema → Protocol → Server and Client → Schema/Protocol.

---

### Task 1: Define audience, group, and restricted-catalog contracts

**Files:**
- Modify: `packages/schema/src/skill-market-control.ts`
- Modify: `packages/schema/src/skill-market.ts`
- Create: `packages/protocol/src/groups/skill-market-groups.ts`
- Modify: `packages/protocol/src/groups/skill-market-submissions.ts`
- Modify: `packages/protocol/src/groups/skill-market-catalog.ts`
- Modify: `packages/protocol/src/skill-market-api.ts`
- Test: `packages/schema/test/skill-market-control.test.ts`
- Test: `packages/protocol/test/skill-market-control.test.ts`
- Test: `packages/client/test/skill-market.test.ts`
- Regenerate: `packages/client/src/generated/`
- Regenerate: `packages/client/src/generated-effect/`

**Interfaces:**
- Produces: `PublicationTarget = "personal" | "groups" | "department" | "company"`.
- Produces: `AudienceTarget`, `MarketGroup`, `MarketGroupMember`, `GroupPage`, `RestrictedVisibility`, and `PrivateInstallGrant` schemas.
- Produces: group CRUD/member routes, audience-change route, personal-promotion route, and install-grant route in `SkillMarketApi`.

- [ ] **Step 1: Write failing schema and route-registration tests**

```ts
expect(
  Schema.decodeUnknownSync(SkillMarketControl.AudienceTarget)({ scope: "groups", groupIDs: ["grp_alpha", "grp_beta"] }),
).toEqual({ scope: "groups", groupIDs: ["grp_alpha", "grp_beta"] })
expect(() =>
  Schema.decodeUnknownSync(SkillMarketControl.AudienceTarget)({ scope: "department", groupIDs: ["grp_alpha"] }),
).toThrow()
expect(apiEndpointNames()).toContain("skillMarket.groups.create")
expect(apiEndpointNames()).toContain("skillMarket.submissions.promote")
expect(apiEndpointNames()).toContain("skillMarket.catalog.privateInstallGrant")
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run from `packages/schema`: `bun test test/skill-market-control.test.ts`

Run from `packages/protocol`: `bun test test/skill-market-control.test.ts`

Expected: failures report missing `AudienceTarget`, group endpoints, and install-grant endpoint.

- [ ] **Step 3: Add the exact discriminated audience schemas and group models**

```ts
export const PublicationTarget = Schema.Literals(["personal", "groups", "department", "company"])
export const GroupID = Schema.String.check(Schema.isPattern(/^grp_[a-zA-Z0-9_-]{8,64}$/))
export const AudienceTarget = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("personal") }),
  Schema.Struct({ scope: Schema.Literal("company") }),
  Schema.Struct({ scope: Schema.Literal("department"), department: Department }),
  Schema.Struct({
    scope: Schema.Literal("groups"),
    groupIDs: Schema.Array(GroupID).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  }),
])
export const MarketGroup = Schema.Struct({
  id: GroupID,
  name: bounded(1, 100),
  description: bounded(1, 500).pipe(optional),
  ownerEmployeeID: EmployeeID,
  status: Schema.Literals(["active", "disabled"]),
  version: Positive,
  createdAt: SkillMarket.Timestamp,
  updatedAt: SkillMarket.Timestamp,
})
```

Add typed endpoints under `/v1/groups`, `/v1/submissions/:submissionID/promotions`, `/v1/submissions/:submissionID/audience-changes`, and `/v1/restricted-skills/:publicationID/install-grants`. Apply session middleware to reads and write middleware to mutations.

- [ ] **Step 4: Regenerate clients and verify GREEN**

Run from `packages/client`: `bun run generate && bun test test/skill-market.test.ts && bun typecheck`

Run from `packages/schema`: `bun test test/skill-market-control.test.ts && bun typecheck`

Run from `packages/protocol`: `bun test test/skill-market-control.test.ts && bun typecheck`

Expected: all commands exit 0 and generated diffs contain the new typed operations.

- [ ] **Step 5: Commit the contracts**

```bash
git add packages/schema/src/skill-market-control.ts packages/schema/src/skill-market.ts packages/schema/test/skill-market-control.test.ts packages/protocol/src/groups/skill-market-groups.ts packages/protocol/src/groups/skill-market-submissions.ts packages/protocol/src/groups/skill-market-catalog.ts packages/protocol/src/skill-market-api.ts packages/protocol/test/skill-market-control.test.ts packages/client/src/generated packages/client/src/generated-effect packages/client/test/skill-market.test.ts
git commit -m "feat(skill-market): define scoped sharing contracts"
```

### Task 2: Persist groups and enforce group-management authority

**Files:**
- Create: `packages/skill-market-server/migrations/011_scoped_sharing.sql`
- Create: `packages/skill-market-server/src/groups.ts`
- Create: `packages/skill-market-server/src/http/groups.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Test: `packages/skill-market-server/test/database.test.ts`
- Create: `packages/skill-market-server/test/groups.test.ts`
- Modify: `packages/skill-market-server/test/control-http.test.ts`

**Interfaces:**
- Consumes: Task 1 `MarketGroup`, `GroupID`, and group endpoint schemas.
- Produces: `createGroups({ database, now })` with `create`, `listMine`, `get`, `update`, `transfer`, `setStatus`, `addMember`, and `removeMember` methods.

- [ ] **Step 1: Write failing migration and authority tests**

```ts
const group = groups.create(alice, { name: "Project Aurora", description: "跨部门专项组" })
expect(group.ownerEmployeeID).toBe(alice.session.user.employeeID)
expect(groups.listMine(bob).joined).toHaveLength(0)
groups.addMember(alice, group.id, { employeeID: "E000099" }, group.version)
expect(
  fixture.database.connection
    .query<{ employee_id: string }, [string, string]>(
      "SELECT employee_id FROM market_group_members WHERE group_id = ? AND employee_id = ?",
    )
    .get(group.id, "E000099"),
).toEqual({ employee_id: "E000099" })
expect(() => groups.addMember(bob, group.id, { employeeID: "E000100" }, group.version)).toThrow("forbidden")
```

- [ ] **Step 2: Run tests and verify RED**

Run from `packages/skill-market-server`: `bun test test/database.test.ts test/groups.test.ts test/control-http.test.ts`

Expected: migration 011 and `createGroups` are missing.

- [ ] **Step 3: Add normalized group tables and service**

```sql
CREATE TABLE market_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  owner_employee_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE market_group_members (
  group_id TEXT NOT NULL REFERENCES market_groups(id),
  employee_id TEXT NOT NULL,
  added_by_employee_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, employee_id)
);
CREATE INDEX market_group_members_employee ON market_group_members(employee_id, group_id);
```

Generate IDs with `grp_${randomSecret()}`. Validate employee IDs with the existing employee-ID schema. Insert the owner membership in the same transaction as group creation. Require the owner or admin for writes, reject removal of the current owner, use `version` for every mutation, and audit create/update/member/transfer/status changes.

- [ ] **Step 4: Bind typed HTTP handlers and verify GREEN**

Run from `packages/skill-market-server`: `bun test test/database.test.ts test/groups.test.ts test/control-http.test.ts && bun typecheck`

Expected: tests pass for pending employee IDs, cross-department membership, optimistic conflicts, ownership transfer, disable/restore, CSRF, and admin override.

- [ ] **Step 5: Commit group management**

```bash
git add packages/skill-market-server/migrations/011_scoped_sharing.sql packages/skill-market-server/src/groups.ts packages/skill-market-server/src/http/groups.ts packages/skill-market-server/src/handlers.ts packages/skill-market-server/src/server.ts packages/skill-market-server/test/database.test.ts packages/skill-market-server/test/groups.test.ts packages/skill-market-server/test/control-http.test.ts
git commit -m "feat(skill-market): add reusable sharing groups"
```

### Task 3: Capture reviewed audiences and publish restricted Skills

**Files:**
- Modify: `packages/skill-market-server/migrations/011_scoped_sharing.sql`
- Create: `packages/skill-market-server/src/audience.ts`
- Create: `packages/skill-market-server/src/restricted-publications.ts`
- Modify: `packages/skill-market-server/src/submissions.ts`
- Modify: `packages/skill-market-server/src/submission-read.ts`
- Modify: `packages/skill-market-server/src/moderation.ts`
- Modify: `packages/skill-market-server/src/publisher.ts`
- Modify: `packages/skill-market-server/src/http/submissions.ts`
- Test: `packages/skill-market-server/test/submissions.test.ts`
- Test: `packages/skill-market-server/test/moderation.test.ts`
- Test: `packages/skill-market-server/test/publisher.test.ts`

**Interfaces:**
- Consumes: Task 2 active groups and authority checks.
- Produces: `requireAudienceTarget(connection, principal, target)` and `canReadRestricted(connection, principal, publicationID)`.
- Produces: `restricted_publications` and immutable reviewed target rows.

- [ ] **Step 1: Write failing audience and publication tests**

```ts
const created = await submissions.create(alice, {
  ...upload("team-helper", "1.0.0"),
  target: { scope: "groups", groupIDs: [aurora.id, atlas.id] },
})
expect(created.submission.target).toEqual({ scope: "groups", groupIDs: [aurora.id, atlas.id] })
expect(submissions.completeValidation(validation(created)).submission.status).toBe("pending_review")
expect(() => submissions.create(bob, { ...upload("blocked", "1.0.0"), target: { scope: "groups", groupIDs: [aurora.id] } })).toThrow("forbidden")
```

- [ ] **Step 2: Run tests and verify RED**

Run from `packages/skill-market-server`: `bun test test/submissions.test.ts test/moderation.test.ts test/publisher.test.ts`

Expected: current two-scope validation rejects `groups` and `department`.

- [ ] **Step 3: Add audience tables and centralized validation**

```sql
ALTER TABLE submissions ADD COLUMN target_department_id TEXT REFERENCES departments(department_id);
CREATE TABLE submission_group_targets (
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  group_id TEXT NOT NULL REFERENCES market_groups(id),
  PRIMARY KEY (submission_id, group_id)
);
CREATE TABLE restricted_publications (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  skill_id TEXT NOT NULL,
  owner_employee_id TEXT NOT NULL,
  version TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('groups', 'department')),
  department_id TEXT REFERENCES departments(department_id),
  package_key TEXT NOT NULL,
  package_sha256 TEXT NOT NULL,
  package_size INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('published', 'delisted')),
  row_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE restricted_publication_groups (
  publication_id TEXT NOT NULL REFERENCES restricted_publications(id),
  group_id TEXT NOT NULL REFERENCES market_groups(id),
  PRIMARY KEY (publication_id, group_id)
);
```

Validate personal/company have no target details, department matches the principal's trusted department, groups are non-empty/deduplicated/active and owned by the principal or administered. Persist targets transactionally. Keep personal immediate, route every other clean scan to `pending_review`, and make approval create company output or a restricted publication according to scope.

- [ ] **Step 4: Add promotion and audience-change requests**

Implement personal promotion by copying the current verified package identity into a new quarantined revision, then enqueue a fresh scan. Implement audience changes as versioned submissions whose approval atomically replaces department/group target rows. Do not modify the personal source record.

```ts
const promotion = await submissions.promote(alice, personal.id, {
  idempotencyKey: "promote-personal-1",
  target: { scope: "department", department: alice.session.user.department! },
})
expect(promotion.submission.status).toBe("validating")
expect(promotion.submission.id).not.toBe(personal.id)
```

- [ ] **Step 5: Verify publication and commit**

Run from `packages/skill-market-server`: `bun test test/submissions.test.ts test/moderation.test.ts test/publisher.test.ts test/worker.test.ts && bun typecheck`

Expected: personal remains immediate; groups/department/company require review; multi-group targets survive approval; audience changes are atomic.

```bash
git add packages/skill-market-server/migrations/011_scoped_sharing.sql packages/skill-market-server/src/audience.ts packages/skill-market-server/src/restricted-publications.ts packages/skill-market-server/src/submissions.ts packages/skill-market-server/src/submission-read.ts packages/skill-market-server/src/moderation.ts packages/skill-market-server/src/publisher.ts packages/skill-market-server/src/http/submissions.ts packages/skill-market-server/test/submissions.test.ts packages/skill-market-server/test/moderation.test.ts packages/skill-market-server/test/publisher.test.ts
git commit -m "feat(skill-market): publish reviewed audiences"
```

### Task 4: Merge authorized restricted catalog reads and issue install grants

**Files:**
- Create: `packages/skill-market-server/src/restricted-catalog.ts`
- Create: `packages/skill-market-server/src/install-grants.ts`
- Modify: `packages/skill-market-server/src/catalog-reader.ts`
- Modify: `packages/skill-market-server/src/http/catalog.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Test: `packages/skill-market-server/test/catalog-reader.test.ts`
- Create: `packages/skill-market-server/test/restricted-catalog.test.ts`
- Modify: `packages/skill-market-server/test/control-http.test.ts`

**Interfaces:**
- Consumes: Task 3 `canReadRestricted` and restricted publications.
- Produces: one optional-session catalog merge and hashed, 10-minute `PrivateInstallGrant` delivery.

- [ ] **Step 1: Write the full failing access matrix**

```ts
expect(await listAs(undefined)).toContain(companySkill)
expect(await listAs(undefined)).not.toContain(groupSkill)
expect(await detailAs(groupMember, groupSkill.id)).toMatchObject({ visibility: "groups" })
expect(await detailStatus(otherEmployee, groupSkill.id)).toBe(404)
expect(await packageStatus(sameDepartment, departmentSkill.id, "HEAD")).toBe(200)
expect(await packageStatus(otherDepartment, departmentSkill.id, "GET")).toBe(404)
```

- [ ] **Step 2: Run tests and verify RED**

Run from `packages/skill-market-server`: `bun test test/catalog-reader.test.ts test/restricted-catalog.test.ts test/control-http.test.ts`

Expected: restricted source and optional-session merge are absent.

- [ ] **Step 3: Implement one access policy for every read surface**

Load authorized restricted summaries with SQL predicates over owner, current department, active group, and live membership. Use the same `requireRestrictedPublication` path for detail, versions, grant issuance, package GET, and package HEAD. Return `404` for every denied direct read and set `private, no-store` on restricted responses.

```ts
const authorizedPublicationSql = `SELECT 1 AS allowed
  FROM restricted_publications
  WHERE id = ? AND status = 'published' AND (
    owner_employee_id = ? OR
    (scope = 'department' AND department_id = (
      SELECT department_id FROM users WHERE employee_id = ?
    )) OR
    (scope = 'groups' AND EXISTS (
      SELECT 1
      FROM restricted_publication_groups
      INNER JOIN market_groups ON market_groups.id = restricted_publication_groups.group_id
      INNER JOIN market_group_members ON market_group_members.group_id = market_groups.id
      WHERE restricted_publication_groups.publication_id = restricted_publications.id
        AND market_groups.status = 'active'
        AND market_group_members.employee_id = ?
    ))
  ) LIMIT 1`

export function canReadRestricted(connection: Database, employeeID: string, publicationID: string) {
  return Boolean(
    connection.query<{ allowed: number }, [string, string, string, string]>(authorizedPublicationSql).get(
      publicationID,
      employeeID,
      employeeID,
      employeeID,
    )?.allowed,
  )
}
```

- [ ] **Step 4: Implement hashed 10-minute grants**

```ts
const token = randomSecret()
connection.run(
  `INSERT INTO private_install_grants
   (token_hash, publication_id, employee_id, expires_at, created_at)
   VALUES (?, ?, ?, ?, ?)`,
  [hashSecret(token), publication.id, principal.session.user.employeeID, now + 10 * 60_000, now],
)
return { url: new URL(`/v1/private-download/${token}`, apiPublicUrl).href, expiresAt: new Date(now + 10 * 60_000).toISOString() }
```

Permit the bounded HEAD/GET installer sequence while the grant is active. Recheck publication status and current employee authorization before delivery. Never log the token.

- [ ] **Step 5: Verify, typecheck, and commit**

Run from `packages/skill-market-server`: `bun test test/catalog-reader.test.ts test/restricted-catalog.test.ts test/control-http.test.ts && bun typecheck`

Expected: the matrix passes, grants expire, disabled groups revoke grants, and no restricted response is publicly cacheable.

```bash
git add packages/skill-market-server/src/restricted-catalog.ts packages/skill-market-server/src/install-grants.ts packages/skill-market-server/src/catalog-reader.ts packages/skill-market-server/src/http/catalog.ts packages/skill-market-server/src/handlers.ts packages/skill-market-server/src/server.ts packages/skill-market-server/test/catalog-reader.test.ts packages/skill-market-server/test/restricted-catalog.test.ts packages/skill-market-server/test/control-http.test.ts
git commit -m "feat(skill-market): authorize restricted catalog"
```

### Task 5: Add group and four-scope Web workflows

**Files:**
- Create: `packages/skill-market-web/src/groups/list.tsx`
- Create: `packages/skill-market-web/src/groups/detail.tsx`
- Create: `packages/skill-market-web/src/groups/list.test.tsx`
- Create: `packages/skill-market-web/src/groups/detail.test.tsx`
- Create: `packages/skill-market-web/src/admin/groups.tsx`
- Create: `packages/skill-market-web/src/admin/groups.test.tsx`
- Modify: `packages/skill-market-web/src/control-data-source.ts`
- Modify: `packages/skill-market-web/src/control-data-source.test.ts`
- Modify: `packages/skill-market-web/src/submissions/form.tsx`
- Modify: `packages/skill-market-web/src/submissions/form.test.tsx`
- Modify: `packages/skill-market-web/src/submissions/detail.tsx`
- Modify: `packages/skill-market-web/src/submissions/detail.test.tsx`
- Modify: `packages/skill-market-web/src/space/layout.tsx`
- Modify: `packages/skill-market-web/src/space/layout.test.tsx`
- Modify: `packages/skill-market-web/src/app.tsx`
- Modify: `packages/skill-market-web/src/styles.css`

**Interfaces:**
- Consumes: Tasks 1–4 typed groups, target, promotion, and restricted catalog operations.
- Produces: `/groups`, `/groups/:id`, four save-location choices, multi-group selection, and **发布给其他人**.

- [ ] **Step 1: Write failing interaction tests**

```tsx
expect(view.getByRole("link", { name: "我的小组" })).toBeTruthy()
fireEvent.click(view.getByRole("radio", { name: /指定小组/ }))
fireEvent.click(view.getByRole("checkbox", { name: "Project Aurora" }))
fireEvent.click(view.getByRole("checkbox", { name: "Project Atlas" }))
fireEvent.click(view.getByRole("button", { name: "提交审核" }))
expect(create).toHaveBeenCalledWith(expect.objectContaining({
  target: { scope: "groups", groupIDs: ["grp_aurora1", "grp_atlas01"] },
}))
```

- [ ] **Step 2: Run Web browser tests and verify RED**

Run from `packages/skill-market-web`: `bun run test:browser`

Expected: group routes, group controls, and four-scope form labels are absent.

- [ ] **Step 3: Add group data source, pages, routes, and forms**

Add `groups.list/create/detail/update/transfer/setStatus/addMember/removeMember` methods to the control data source. Add **我的小组** under **我的空间**, split managed and joined groups, support pending employee IDs, and show owner-only management actions. Add **小组管理** under the administration layout so administrators can find and manage every group. Render four Chinese save-location cards. Disable department when the session has no department. Only list active groups managed by the actor in the group multi-select.

- [ ] **Step 4: Add personal promotion and private install prompt UI**

On published personal detail, render **发布给其他人** and collect one non-personal audience. On restricted details, request a grant only when the user clicks **复制安装 Prompt** and insert the returned short-lived URL into the prompt. Never store grants in query cache beyond their expiry.

- [ ] **Step 5: Verify and commit**

Run from `packages/skill-market-web`: `bun run test:unit && bun run test:browser && bun typecheck && bun run build`

Expected: all commands exit 0 and no group member can see management controls.

```bash
git add packages/skill-market-web/src/groups packages/skill-market-web/src/admin/groups.tsx packages/skill-market-web/src/admin/groups.test.tsx packages/skill-market-web/src/control-data-source.ts packages/skill-market-web/src/control-data-source.test.ts packages/skill-market-web/src/submissions/form.tsx packages/skill-market-web/src/submissions/form.test.tsx packages/skill-market-web/src/submissions/detail.tsx packages/skill-market-web/src/submissions/detail.test.tsx packages/skill-market-web/src/space/layout.tsx packages/skill-market-web/src/space/layout.test.tsx packages/skill-market-web/src/app.tsx packages/skill-market-web/src/styles.css
git commit -m "feat(skill-market): add scoped sharing UI"
```

### Task 6: Complete moderation, end-to-end authorization, and deployment gates

**Files:**
- Modify: `packages/skill-market-web/src/admin/queue.tsx`
- Modify: `packages/skill-market-web/src/admin/queue.test.tsx`
- Modify: `packages/skill-market-web/src/admin/review.tsx`
- Modify: `packages/skill-market-web/src/admin/review.test.tsx`
- Modify: `packages/skill-market-web/e2e/fixtures/server.ts`
- Modify: `packages/skill-market-web/e2e/market.e2e.ts`
- Modify: `packages/skill-market-server/script/backup.ts`
- Modify: `packages/skill-market-server/script/backup.test.ts`
- Modify: `packages/skill-market-server/script/deploy-check.ts`
- Modify: `packages/skill-market-server/script/deploy-check.test.ts`
- Modify: `packages/skill-market-server/README.md`
- Modify: `packages/skill-market-server/deploy/README.md`

**Interfaces:**
- Consumes: all scoped-sharing tasks.
- Produces: release-ready access matrix, migration backup coverage, gateway cache checks, and operational documentation.

- [ ] **Step 1: Write failing moderation and E2E journeys**

Add controlled accounts for group owner, member, outsider, same department, other department, reviewer, and admin. Assert the reviewer sees exact targets, approval publishes the right audience, outsiders receive `404`, and disabled groups revoke access without duplicate cards.

```ts
await expect(memberPage.getByText("Project Aurora Helper")).toBeVisible()
await expect(outsiderPage.goto(restrictedDetailUrl)).resolves.toMatchObject({ status: 404 })
await expect(anonymousPage.getByText("Company Helper")).toBeVisible()
await expect(anonymousPage.getByText("Project Aurora Helper")).toHaveCount(0)
```

- [ ] **Step 2: Run E2E and deployment tests and verify RED**

Run from `packages/skill-market-web`: `bun run test:e2e`

Run from `packages/skill-market-server`: `bun test script/backup.test.ts script/deploy-check.test.ts`

Expected: fixtures lack scoped publication and backup/deploy checks lack new tables/cache rules.

- [ ] **Step 3: Complete UI, backup, preflight, and documentation**

Show scope badges and target names in moderation. Include new tables and private installation-grant metadata in verified backups. Make deploy preflight reject cacheable restricted endpoints and overlapping public/private prefixes. Document migration, rollback feature flags, access matrix, and sensitive-log exclusions.

- [ ] **Step 4: Run the complete package gates**

Run from `packages/schema`: `bun test && bun typecheck`

Run from `packages/protocol`: `bun test && bun typecheck`

Run from `packages/client`: `bun run check:generated && bun test && bun typecheck`

Run from `packages/skill-market-server`: `bun test && bun typecheck`

Run from `packages/skill-market-web`: `bun test && bun typecheck && bun run build && bun run test:e2e`

Expected: zero failures, zero generated diffs, and a successful production Web build.

- [ ] **Step 5: Commit release gates**

```bash
git add packages/skill-market-web/src/admin packages/skill-market-web/e2e packages/skill-market-server/script packages/skill-market-server/README.md packages/skill-market-server/deploy/README.md
git commit -m "test(skill-market): verify scoped sharing"
```

Do not deploy until the lifecycle plan and typography plan are complete, the production database backup verifies, and controlled two-department accounts pass the authorization matrix.
