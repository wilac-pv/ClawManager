# Role Preassignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Admin assign Reviewer or Admin to an employee before that employee's first SSO login.

**Architecture:** Insert a minimal placeholder user in the existing role-assignment transaction, without overwriting provisioned or disabled users. Keep SSO provisioning authoritative for display identity and preserve role/audit/last-Admin protections.

**Tech Stack:** Bun, TypeScript, SQLite, Effect HTTP API, Effect Schema, Bun test.

## Global Constraints

- Do not change the public `RoleInput` or `RoleAssignment` schema.
- Only a current Admin with valid Origin and CSRF may assign roles.
- Do not overwrite existing display names, emails, login timestamps, or disabled state.
- A failed transaction must not retain a placeholder, role, or audit event.
- Run tests and `bun typecheck` only from `packages/skill-market-server`.
- Follow TDD: every production change follows a test that fails for the expected reason.

---

### Task 1: Create role placeholders atomically

**Files:**
- Modify: `packages/skill-market-server/test/moderation.test.ts`
- Modify: `packages/skill-market-server/src/moderation.ts`

**Interfaces:**
- Consumes: existing `Moderation.assignRole(...)`, `users`, `role_assignments`, and `audit_events`.
- Produces: a successful `RoleAssignment` for a validated employee ID absent from `users`.

- [ ] **Step 1: Write the failing missing-user test**

Delete a fixture user, assign a role, and assert:

```ts
const assigned = moderation.assignRole(fixture.admin, {
  employeeID: "future-user",
  role: "reviewer",
})
expect(assigned.user).toMatchObject({
  employeeID: "future-user",
  displayName: "future-user",
})
```

Query SQLite and require exactly one user, one role, and one `role-assigned` audit event for the target.

Add cases proving invalid input creates nothing, duplicate assignment adds no audit event, and existing provisioned/disabled user fields remain unchanged.

- [ ] **Step 2: Run the test and verify RED**

```bash
bun test test/moderation.test.ts
```

Expected: FAIL with `role target user was not found`.

- [ ] **Step 3: Insert the placeholder inside the transaction**

Before reading the target, execute:

```sql
INSERT INTO users (employee_id, display_name, created_at, last_login_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(employee_id) DO NOTHING
```

Use the validated employee ID for both identity fields and the assignment timestamp for both timestamps. Keep duplicate detection, role insertion, audit insertion, and result reading in the same transaction.

- [ ] **Step 4: Run moderation tests and verify GREEN**

```bash
bun test test/moderation.test.ts
```

Expected: all moderation tests PASS.

- [ ] **Step 5: Commit the transaction change**

```bash
git add packages/skill-market-server/src/moderation.ts \
  packages/skill-market-server/test/moderation.test.ts
git commit -m "fix(skill-market): allow role preassignment"
```

---

### Task 2: Prove SSO hydration and safe duplicate feedback

**Files:**
- Modify: `packages/skill-market-server/test/auth.test.ts`
- Modify: `packages/skill-market-server/test/control-http.test.ts`
- Modify: `packages/skill-market-server/src/http/admin.ts`

**Interfaces:**
- Consumes: placeholder behavior from Task 1 and existing SSO upsert.
- Produces: trusted display-name hydration plus a specific duplicate-role operator message.

- [ ] **Step 1: Write the failing SSO hydration test**

Seed a placeholder with Reviewer, complete SSO with a trusted token identity for
the same employee ID, and assert:

```ts
expect(result.session.user.displayName).toBe("Trusted Name")
expect(result.session.roles).toContain("reviewer")
```

Also verify the database still has one user and one role.

- [ ] **Step 2: Write the failing duplicate HTTP test**

Call `POST /v1/admin/roles` twice with the same employee ID and role. Require the second response to stay bounded and contain a safe message such as `该员工已拥有此角色` plus a valid request ID.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
bun test test/auth.test.ts test/control-http.test.ts
```

Expected: hydration already demonstrates compatibility, while duplicate HTTP feedback FAILS because the handler returns the generic role-request message.

- [ ] **Step 4: Map duplicate assignment safely**

Keep protocol code `invalid-request`. In `roleCreateProblem(...)`, distinguish the internal duplicate-role guard from malformed input and return:

```ts
message: "该员工已拥有此角色"
```

Do not expose SQL, stack traces, user records, or request bodies.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
bun test test/moderation.test.ts test/auth.test.ts test/control-http.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 6: Commit compatibility and feedback**

```bash
git add packages/skill-market-server/src/http/admin.ts \
  packages/skill-market-server/test/auth.test.ts \
  packages/skill-market-server/test/control-http.test.ts
git commit -m "fix(skill-market): clarify duplicate role assignment"
```

---

### Task 3: Verify control-plane behavior

**Files:**
- Modify only if a regression test exposes a missing assertion.

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: verification evidence for release.

- [ ] **Step 1: Run all role, auth, and security tests**

```bash
bun test test/moderation.test.ts test/auth.test.ts test/security.test.ts test/control-http.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run the complete package suite**

```bash
bun test
bun typecheck
```

Expected: zero failures and typecheck exit code 0.

- [ ] **Step 3: Review the release diff**

```bash
git diff dev...HEAD --check
git diff --stat dev...HEAD
```

Expected: only the two approved server fixes, their tests, and their design/plan documents.

