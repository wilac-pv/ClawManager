import { afterEach, describe, expect, test } from "bun:test"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { createModeration } from "../src/moderation"
import type { Principal } from "../src/security"
import { createSecurity, SkillMarketSecurityError } from "../src/security"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("submission moderation", () => {
  test("accepts exactly one concurrent decision", async () => {
    const fixture = await moderationFixture()
    const submissionID = seedSubmission(fixture, { owner: "author", risk: "safe" })
    const moderation = createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    })

    const decisions = await Promise.allSettled([
      Promise.resolve().then(() =>
        moderation.decide(fixture.reviewer, submissionID, { expectedVersion: 2, decision: "approve" }),
      ),
      Promise.resolve().then(() =>
        moderation.decide(fixture.secondReviewer, submissionID, {
          expectedVersion: 2,
          decision: "reject",
          comment: "Not ready",
        }),
      ),
    ])
    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1)
    expect(decisions.filter((decision) => decision.status === "rejected")).toHaveLength(1)
    const rejected = decisions.find((decision) => decision.status === "rejected")
    expect(rejected?.reason).toBeInstanceOf(SkillMarketSecurityError)
    expect(rejected?.reason.code).toBe("submission-conflict")
    expect(rowCount(fixture, "reviews")).toBe(1)
    expect(rowCount(fixture, "publish_jobs")).toBe(1)
    expect(
      fixture.database.connection
        .query<
          { action: string; actor_employee_id: string; before_json: string; after_json: string },
          []
        >("SELECT action, actor_employee_id, before_json, after_json FROM audit_events")
        .get(),
    ).toMatchObject({
      action: "review-approved",
      actor_employee_id: "reviewer",
      before_json: JSON.stringify({ status: "pending_review", version: 2 }),
      after_json: JSON.stringify({ status: "publishing", version: 3 }),
    })

    fixture.database.close()
  })

  test("allows Admin to approve an owned submission with review and audit records", async () => {
    const fixture = await moderationFixture()
    const submissionID = seedSubmission(fixture, { owner: "admin", risk: "safe", salt: "admin-own" })
    const moderation = createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    })

    const result = moderation.decide(fixture.admin, submissionID, {
      expectedVersion: 2,
      decision: "approve",
      comment: "Admin reviewed the package",
    })

    expect(result).toMatchObject({ id: submissionID, status: "publishing", version: 3 })
    expect(rowCount(fixture, "reviews")).toBe(1)
    expect(rowCount(fixture, "publish_jobs")).toBe(1)
    expect(
      fixture.database.connection
        .query<
          { reviewer_employee_id: string; decision: string; comment: string },
          []
        >("SELECT reviewer_employee_id, decision, comment FROM reviews")
        .get(),
    ).toEqual({
      reviewer_employee_id: "admin",
      decision: "approve",
      comment: "Admin reviewed the package",
    })
    expect(
      fixture.database.connection
        .query<
          { action: string; actor_employee_id: string; before_json: string; after_json: string },
          []
        >("SELECT action, actor_employee_id, before_json, after_json FROM audit_events")
        .get(),
    ).toEqual({
      action: "review-approved",
      actor_employee_id: "admin",
      before_json: JSON.stringify({ status: "pending_review", version: 2 }),
      after_json: JSON.stringify({ status: "publishing", version: 3 }),
    })

    fixture.database.close()
  })

  test("validates comments, risk acceptance, review state, and redacts secret scan evidence", async () => {
    const fixture = await moderationFixture()
    const moderation = createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    })
    const changes = seedSubmission(fixture, { owner: "author", risk: "safe", salt: "changes" })
    const rejected = seedSubmission(fixture, { owner: "author", risk: "safe", salt: "rejected" })
    const risky = seedSubmission(fixture, { owner: "author", risk: "warning", salt: "risky" })

    await expectCode(
      () => moderation.decide(fixture.reviewer, changes, { expectedVersion: 2, decision: "request_changes" }),
      "invalid-request",
    )
    await expectCode(
      () => moderation.decide(fixture.reviewer, rejected, { expectedVersion: 2, decision: "reject" }),
      "invalid-request",
    )
    await expectCode(
      () => moderation.decide(fixture.reviewer, risky, { expectedVersion: 2, decision: "approve" }),
      "invalid-request",
    )
    const approved = moderation.decide(fixture.reviewer, risky, {
      expectedVersion: 2,
      decision: "approve",
      acceptedRiskSummary: "Reviewed script behavior and accepted the warning",
    })
    expect(approved.status).toBe("publishing")

    fixture.database.connection.run("UPDATE submissions SET status = 'changes_requested', version = 3 WHERE id = ?", [
      changes,
    ])
    await expectCode(
      () => moderation.decide(fixture.reviewer, changes, { expectedVersion: 3, decision: "approve" }),
      "submission-conflict",
    )

    const marker = `sk-${"A1b2".repeat(12)}`
    const secret = seedSubmission(fixture, { owner: "author", risk: "danger", salt: "secret", marker })
    const detail = moderation.get(fixture.reviewer, secret)
    expect(JSON.stringify(detail)).not.toContain(marker)
    expect(detail.revisions[0]?.scan?.evidence[0]?.summary).toBe("Sensitive scan evidence redacted")

    fixture.database.close()
  })

  test("filters the review queue and append-only audit log with typed pages", async () => {
    const fixture = await moderationFixture()
    const moderation = createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    })
    const safe = seedSubmission(fixture, { owner: "author", risk: "safe", salt: "queue-safe" })
    fixture.clock.value += 1_000
    const danger = seedSubmission(fixture, { owner: "author", risk: "danger", salt: "queue-danger" })

    const page = moderation.listQueue(fixture.reviewer, {
      status: "pending_review",
      risk: "danger",
      submitter: "author",
      createdFrom: new Date(fixture.clock.value).toISOString(),
      createdTo: new Date(fixture.clock.value).toISOString(),
      page: 1,
      limit: 10,
    })
    expect(page.total).toBe(1)
    expect(page.items.map((submission) => submission.id)).toEqual([danger])
    await expectCode(() => moderation.listQueue(fixture.author, { page: 1, limit: 10 }), "forbidden")

    moderation.decide(fixture.reviewer, safe, {
      expectedVersion: 2,
      decision: "request_changes",
      comment: "Clarify the installation steps",
    })
    const audits = moderation.listAudit(fixture.admin, {
      actor: "reviewer",
      action: "review-changes-requested",
      objectType: "submission",
      objectID: safe,
      createdFrom: new Date(fixture.clock.value - 1_000).toISOString(),
      createdTo: new Date(fixture.clock.value).toISOString(),
      page: 1,
      limit: 10,
    })
    expect(audits.total).toBe(1)
    expect(audits.items[0]).toMatchObject({
      actor: { employeeID: "reviewer" },
      action: "review-changes-requested",
      objectType: "submission",
      objectID: safe,
      before: { status: "pending_review", version: 2 },
      after: { status: "changes_requested", version: 3 },
    })
    await expectCode(() => moderation.listAudit(fixture.reviewer, { page: 1, limit: 10 }), "forbidden")

    fixture.database.close()
  })

  test("administers roles atomically without allowing removal of the final Admin", async () => {
    const fixture = await moderationFixture()
    const moderation = createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    })

    expect(
      moderation.listRoles(fixture.admin).map((assignment) => `${assignment.user.employeeID}:${assignment.role}`),
    ).toEqual(["admin:admin", "reviewer:reviewer", "reviewer2:reviewer"])
    const assigned = moderation.assignRole(fixture.admin, { employeeID: "author", role: "reviewer" })
    expect(assigned).toMatchObject({ user: { employeeID: "author" }, role: "reviewer", createdBy: "admin" })
    await expectCode(
      () => moderation.assignRole(fixture.reviewer, { employeeID: "author", role: "admin" }),
      "forbidden",
    )
    await expectCode(
      () => moderation.assignRole(fixture.admin, { employeeID: "author", role: "reviewer" }),
      "invalid-request",
    )
    expect(
      moderation.removeRole(fixture.admin, "author", "reviewer").some((role) => role.user.employeeID === "author"),
    ).toBe(false)
    await expectCode(() => moderation.removeRole(fixture.admin, "author", "reviewer"), "not-found")

    moderation.assignRole(fixture.admin, { employeeID: "reviewer", role: "admin" })
    moderation.removeRole(fixture.admin, "admin", "admin")
    const replacementAdmin = principal("reviewer", ["reviewer", "admin"])
    await expectCode(() => moderation.removeRole(replacementAdmin, "reviewer", "admin"), "last-admin")
    expect(
      fixture.database.connection
        .query<{ action: string }, []>(
          "SELECT action FROM audit_events WHERE action IN ('role-assigned', 'role-removed') ORDER BY rowid",
        )
        .all()
        .map((audit) => audit.action),
    ).toEqual(["role-assigned", "role-removed", "role-assigned", "role-removed"])

    fixture.database.close()
  })

  test("preassigns a role before the employee's first login without duplicating audit records", async () => {
    const fixture = await moderationFixture()
    const moderation = createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    })

    const usersBefore = rowCount(fixture, "users")
    await expectCode(
      () => moderation.assignRole(fixture.admin, { employeeID: "", role: "reviewer" }),
      "invalid-request",
    )
    expect(rowCount(fixture, "users")).toBe(usersBefore)
    expect(moderation.assignRole(fixture.admin, { employeeID: "future-user", role: "reviewer" })).toMatchObject({
      user: { employeeID: "future-user", displayName: "future-user" },
      role: "reviewer",
      createdBy: "admin",
    })
    expect(
      fixture.database.connection
        .query<
          { display_name: string; created_at: number; last_login_at: number },
          [string]
        >("SELECT display_name, created_at, last_login_at FROM users WHERE employee_id = ?")
        .get("future-user"),
    ).toEqual({
      display_name: "future-user",
      created_at: fixture.clock.value,
      last_login_at: fixture.clock.value,
    })
    await expectCode(
      () => moderation.assignRole(fixture.admin, { employeeID: "future-user", role: "reviewer" }),
      "invalid-request",
    )
    expect(
      fixture.database.connection
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM audit_events WHERE object_id = 'future-user:reviewer'")
        .get()!.count,
    ).toBe(1)

    fixture.database.close()
  })

  test("preserves every existing user field when assigning a role", async () => {
    const fixture = await moderationFixture()
    const moderation = createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    })
    const createdAt = fixture.clock.value - 10_000
    const lastLoginAt = fixture.clock.value - 5_000
    const disabledAt = fixture.clock.value - 1_000
    fixture.database.connection.run(
      `UPDATE users
       SET display_name = ?, email = ?, created_at = ?, last_login_at = ?, disabled_at = ?
       WHERE employee_id = ?`,
      ["Provisioned Author", "provisioned@example.com", createdAt, lastLoginAt, disabledAt, "author"],
    )

    moderation.assignRole(fixture.admin, { employeeID: "author", role: "reviewer" })

    expect(
      fixture.database.connection
        .query<
          {
            display_name: string
            email: string
            created_at: number
            last_login_at: number
            disabled_at: number
          },
          [string]
        >("SELECT display_name, email, created_at, last_login_at, disabled_at FROM users WHERE employee_id = ?")
        .get("author"),
    ).toEqual({
      display_name: "Provisioned Author",
      email: "provisioned@example.com",
      created_at: createdAt,
      last_login_at: lastLoginAt,
      disabled_at: disabledAt,
    })

    fixture.database.close()
  })

  test("delists, restores, and retries publishing with optimistic and idempotent guards", async () => {
    const fixture = await moderationFixture()
    const moderation = createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    })
    const published = seedSubmission(fixture, { owner: "author", risk: "safe", salt: "published" })
    const skillID = publishSubmission(fixture, published)
    const auditMarker = `sk-${"Z9y8".repeat(12)}`
    fixture.database.connection.run(
      `INSERT INTO publish_jobs
        (id, kind, status, lease_owner, lease_expires_at, attempts, created_at, updated_at)
       VALUES ('job_running_rebuild', 'catalog_rebuild', 'running', 'worker-a', ?, 1, ?, ?)`,
      [fixture.clock.value + 60_000, fixture.clock.value, fixture.clock.value],
    )

    await expectCode(
      () => moderation.delist(fixture.reviewer, skillID, { expectedVersion: 1, reason: "Policy review" }),
      "forbidden",
    )
    expect(
      moderation.delist(fixture.admin, skillID, {
        expectedVersion: 1,
        reason: `Policy review ${auditMarker}`,
      }),
    ).toEqual({ source: "community", id: skillID, version: "1.0.0", rowVersion: 2, status: "delisted" })
    expect(
      fixture.database.connection
        .query<{ after_json: string }, []>("SELECT after_json FROM audit_events WHERE action = 'community-delisted'")
        .get()!.after_json,
    ).not.toContain(auditMarker)
    expect(rowCount(fixture, "submissions")).toBe(1)
    expect(rowCount(fixture, "submission_revisions")).toBe(1)
    expect(jobCount(fixture, "catalog_rebuild", "pending")).toBe(1)
    expect(jobCount(fixture, "catalog_rebuild", "running")).toBe(1)
    await expectCode(
      () => moderation.restore(fixture.admin, skillID, { expectedVersion: 1, reason: "Stale restore" }),
      "submission-conflict",
    )
    expect(
      moderation.restore(fixture.admin, skillID, { expectedVersion: 2, reason: "Policy review completed" }),
    ).toEqual({
      source: "community",
      id: skillID,
      version: "1.0.0",
      rowVersion: 3,
      status: "published",
    })
    expect(jobCount(fixture, "catalog_rebuild", "pending")).toBe(1)

    const failed = seedSubmission(fixture, { owner: "author", risk: "safe", salt: "publish-failed" })
    fixture.database.transaction((connection) => {
      connection.run("UPDATE submissions SET status = 'publish_failed', version = 3 WHERE id = ?", [failed])
      connection.run(
        `INSERT INTO publish_jobs
          (id, submission_id, kind, status, attempts, error_code, error_summary, created_at, updated_at)
         VALUES ('job_failed_publish', ?, 'publish', 'failed', 1, 'oss-error', 'copy failed', ?, ?)`,
        [failed, fixture.clock.value, fixture.clock.value],
      )
    })
    const retried = moderation.retryPublish(fixture.admin, failed, { expectedVersion: 3 })
    expect(retried).toMatchObject({ status: "publishing", version: 4 })
    expect(jobCount(fixture, "publish", "pending", failed)).toBe(1)
    await expectCode(
      () => moderation.retryPublish(fixture.admin, failed, { expectedVersion: 3 }),
      "submission-conflict",
    )
    expect(jobCount(fixture, "publish", "pending", failed)).toBe(1)

    fixture.database.close()
  })

  test("lets only Admin approve or reject an owner delist request with atomic visibility", async () => {
    const fixture = await moderationFixture()
    const moderation = createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    })
    const approvedSubmission = seedSubmission(fixture, { owner: "author", risk: "safe", salt: "owner-approved" })
    const approvedSkill = publishSubmission(fixture, approvedSubmission)
    const rejectedSubmission = seedSubmission(fixture, { owner: "author", risk: "safe", salt: "owner-rejected" })
    const rejectedSkill = publishSubmission(fixture, rejectedSubmission)
    fixture.database.connection.run(
      `INSERT INTO delist_requests
        (id, submission_id, requested_by_employee_id, reason, status, version, created_at)
       VALUES ('dlr_approved123', ?, 'author', 'Retire approved Skill', 'pending', 1, ?),
              ('dlr_rejected123', ?, 'author', 'Retire rejected Skill', 'pending', 1, ?)`,
      [approvedSubmission, fixture.clock.value, rejectedSubmission, fixture.clock.value],
    )

    await expectCode(
      () => moderation.decideDelist(fixture.reviewer, "dlr_approved123", { expectedVersion: 1 }, "approved"),
      "forbidden",
    )
    expect(
      moderation.decideDelist(fixture.admin, "dlr_approved123", { expectedVersion: 1 }, "approved"),
    ).toMatchObject({ status: "approved", version: 2, decidedByEmployeeID: "admin" })
    expect(
      fixture.database.connection
        .query<{ public_status: string }, [string]>("SELECT public_status FROM community_skills WHERE skill_id = ?")
        .get(approvedSkill),
    ).toEqual({ public_status: "delisted" })
    expect(jobCount(fixture, "catalog_rebuild", "pending")).toBe(1)
    await expectCode(
      () => moderation.decideDelist(fixture.admin, "dlr_approved123", { expectedVersion: 1 }, "approved"),
      "submission-conflict",
    )

    expect(
      moderation.decideDelist(fixture.admin, "dlr_rejected123", { expectedVersion: 1 }, "rejected"),
    ).toMatchObject({ status: "rejected", version: 2, decidedByEmployeeID: "admin" })
    expect(
      fixture.database.connection
        .query<{ public_status: string }, [string]>("SELECT public_status FROM community_skills WHERE skill_id = ?")
        .get(rejectedSkill),
    ).toEqual({ public_status: "published" })

    fixture.database.close()
  })

  test("reviews scoped audiences and preserves their immutable target snapshot", async () => {
    const fixture = await moderationFixture()
    const groups = seedSubmission(fixture, {
      owner: "author",
      risk: "safe",
      salt: "scoped-groups",
      target: "groups",
      groupIDs: ["grp_aurora123", "grp_atlas1234"],
    })
    const department = seedSubmission(fixture, {
      owner: "author",
      risk: "safe",
      salt: "scoped-department",
      target: "department",
      departmentID: "engineering",
    })
    const moderation = createModeration({
      database: fixture.database,
      security: fixture.security,
      now: () => fixture.clock.value,
    })

    const queue = moderation.listQueue(fixture.reviewer, { status: "pending_review", page: 1, limit: 10 })
    expect(queue.items.map((item) => item.id)).toEqual([department, groups])
    expect(queue.items.find((item) => item.id === groups)).toMatchObject({
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_atlas1234", "grp_aurora123"] },
    })
    expect(queue.items.find((item) => item.id === department)).toMatchObject({
      target: "department",
      audience: { scope: "department", department: { id: "engineering", name: "Engineering" } },
    })

    const approved = moderation.decide(fixture.reviewer, groups, { expectedVersion: 2, decision: "approve" })
    expect(approved).toMatchObject({ status: "publishing", version: 3 })
    expect(
      fixture.database.connection
        .query<
          { group_id: string },
          [string]
        >("SELECT group_id FROM submission_group_targets WHERE submission_id = ? ORDER BY group_id")
        .all(groups),
    ).toEqual([{ group_id: "grp_atlas1234" }, { group_id: "grp_aurora123" }])
    expect(
      fixture.database.connection
        .query<
          {
            approved_package_key: string | null
            approved_package_sha256: string | null
            approved_package_size: number | null
            approved_metadata_json: string | null
          },
          [string]
        >(
          `SELECT approved_package_key, approved_package_sha256, approved_package_size, approved_metadata_json
           FROM reviews WHERE submission_id = ? AND decision = 'approve'`,
        )
        .get(groups),
    ).toEqual(
      fixture.database.connection
        .query<
          {
            approved_package_key: string
            approved_package_sha256: string
            approved_package_size: number
            approved_metadata_json: string
          },
          [string]
        >(
          `SELECT
            private_package_key AS approved_package_key,
            package_sha256 AS approved_package_sha256,
            package_size AS approved_package_size,
            metadata_json AS approved_metadata_json
           FROM submission_revisions WHERE submission_id = ? AND revision_number = 1`,
        )
        .get(groups),
    )
    expect(jobCount(fixture, "publish", "pending", groups)).toBe(1)

    fixture.database.close()
  })
})

async function moderationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-moderation-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const clock = { value: Date.parse("2026-07-15T00:00:00.000Z") }
  const roles = {
    author: [],
    reviewer: ["reviewer"],
    reviewer2: ["reviewer"],
    admin: ["admin"],
  } as const
  database.transaction((connection) => {
    connection.run(
      `INSERT INTO departments (department_id, display_name, first_seen_at, last_seen_at)
       VALUES ('engineering', 'Engineering', ?, ?)`,
      [clock.value, clock.value],
    )
    Object.keys(roles).forEach((employeeID) =>
      connection.run(
        "INSERT INTO users (employee_id, display_name, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
        [employeeID, employeeID.toUpperCase(), `${employeeID}@example.com`, clock.value, clock.value],
      ),
    )
    Object.entries(roles).forEach(([employeeID, assigned]) =>
      assigned.forEach((role) =>
        connection.run(
          "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, ?, 'admin', ?)",
          [employeeID, role, clock.value],
        ),
      ),
    )
    ;["grp_aurora123", "grp_atlas1234"].forEach((groupID) => {
      connection.run(
        `INSERT INTO market_groups (id, name, owner_employee_id, status, version, created_at, updated_at)
         VALUES (?, ?, 'author', 'active', 1, ?, ?)`,
        [groupID, groupID, clock.value, clock.value],
      )
      connection.run(
        `INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at)
         VALUES (?, 'author', 'author', ?)`,
        [groupID, clock.value],
      )
    })
  })
  const security = createSecurity({
    database,
    webOrigin: "http://127.0.0.1:4211",
    sessionIdleMilliseconds: 2 * 60 * 60 * 1_000,
    sessionAbsoluteMilliseconds: 12 * 60 * 60 * 1_000,
    now: () => clock.value,
  })
  return {
    database,
    security,
    clock,
    author: principal("author", []),
    reviewer: principal("reviewer", ["reviewer"]),
    secondReviewer: principal("reviewer2", ["reviewer"]),
    admin: principal("admin", ["admin"]),
  }
}

function principal(employeeID: string, roles: ReadonlyArray<SkillMarketControl.Role>): Principal {
  return {
    session: {
      user: { employeeID, displayName: employeeID.toUpperCase(), email: `${employeeID}@example.com` },
      roles,
      csrfToken: new Bun.CryptoHasher("sha256").update(`${employeeID}:csrf`).digest("base64url"),
      createdAt: "2026-07-15T00:00:00.000Z",
      absoluteExpiresAt: "2026-07-15T12:00:00.000Z",
      idleExpiresAt: "2026-07-15T02:00:00.000Z",
    },
    csrfHash: new Bun.CryptoHasher("sha256").update(`${employeeID}:csrf-hash`).digest("hex"),
  }
}

function seedSubmission(
  fixture: Awaited<ReturnType<typeof moderationFixture>>,
  options: {
    owner: string
    risk: SkillMarketControl.ScanReport["risk"]
    salt?: string
    marker?: string
    target?: SkillMarketControl.PublicationTarget
    departmentID?: string
    groupIDs?: ReadonlyArray<SkillMarketControl.GroupID>
  },
) {
  const salt = options.salt ?? options.risk
  const submissionID = `sub_${new Bun.CryptoHasher("sha256").update(`${options.owner}:${salt}`).digest("hex").slice(0, 16)}`
  const skillID = `skill-${salt}`
  const metadata = {
    version: "1.0.0",
    displayName: `Skill ${salt}`,
    description: "A community skill pending review",
    category: "Development",
    tags: ["tools"],
    license: "MIT",
    requiresApiKey: false,
    changeNotes: "Initial release",
  } satisfies SkillMarketControl.SubmissionMetadata
  const scan = {
    risk: options.risk,
    reasons: options.marker ? [`Credential ${options.marker}`] : [],
    evidence: options.marker
      ? [{ rule: "likely-credential", summary: `Found ${options.marker}`, path: `secrets/${options.marker}.txt` }]
      : [],
    scannedAt: "2026-07-15T00:00:00.000Z",
  } satisfies SkillMarketControl.ScanReport
  fixture.database.transaction((connection) => {
    connection.run(
      `INSERT INTO submissions
        (id, skill_id, owner_employee_id, target_version, target_scope, target_department_id,
         status, current_revision, version, created_at, updated_at)
       VALUES (?, ?, ?, '1.0.0', ?, ?, 'validating', 1, 2, ?, ?)`,
      [
        submissionID,
        skillID,
        options.owner,
        options.target ?? "company",
        options.departmentID ?? null,
        fixture.clock.value,
        fixture.clock.value,
      ],
    )
    options.groupIDs?.forEach((groupID) =>
      connection.run("INSERT INTO submission_group_targets (submission_id, group_id) VALUES (?, ?)", [
        submissionID,
        groupID,
      ]),
    )
    connection.run(
      `INSERT INTO submission_revisions
        (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json,
         manifest_json, scan_json, validation_errors_json, validation_completed_at, created_at)
       VALUES (?, 1, ?, ?, 100, ?, ?, ?, '[]', ?, ?)`,
      [
        submissionID,
        `private/${submissionID}/package.zip`,
        new Bun.CryptoHasher("sha256").update(submissionID).digest("hex"),
        JSON.stringify(metadata),
        JSON.stringify({
          packageSha256: new Bun.CryptoHasher("sha256").update(submissionID).digest("hex"),
          packageSize: 100,
          files: [],
        }),
        JSON.stringify(scan),
        fixture.clock.value,
        fixture.clock.value,
      ],
    )
    if (!options.target || options.target === "company")
      connection.run(
        `INSERT INTO community_skills
          (skill_id, owner_employee_id, version, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
        [skillID, options.owner, fixture.clock.value, fixture.clock.value],
      )
    connection.run("UPDATE submissions SET status = 'pending_review' WHERE id = ?", [submissionID])
  })
  return submissionID
}

function publishSubmission(fixture: Awaited<ReturnType<typeof moderationFixture>>, submissionID: string) {
  const submission = fixture.database.connection
    .query<
      { skill_id: string; target_version: string },
      [string]
    >("SELECT skill_id, target_version FROM submissions WHERE id = ?")
    .get(submissionID)
  if (!submission) throw new Error("submission was not seeded")
  fixture.database.transaction((connection) => {
    connection.run("UPDATE submissions SET status = 'published', version = 3 WHERE id = ?", [submissionID])
    connection.run(
      `UPDATE community_skills
       SET current_version = ?, current_submission_id = ?, public_status = 'published', updated_at = ?
       WHERE skill_id = ?`,
      [submission.target_version, submissionID, fixture.clock.value, submission.skill_id],
    )
  })
  return submission.skill_id
}

function rowCount(fixture: Awaited<ReturnType<typeof moderationFixture>>, table: string) {
  if (!new Set(["users", "submissions", "submission_revisions", "reviews", "publish_jobs", "audit_events"]).has(table))
    throw new Error("unsupported table")
  return fixture.database.connection.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count
}

function jobCount(
  fixture: Awaited<ReturnType<typeof moderationFixture>>,
  kind: "publish" | "catalog_rebuild",
  status: "pending" | "running" | "failed" | "completed",
  submissionID?: string,
) {
  if (submissionID)
    return fixture.database.connection
      .query<
        { count: number },
        [string, string, string]
      >("SELECT count(*) AS count FROM publish_jobs WHERE kind = ? AND status = ? AND submission_id = ?")
      .get(kind, status, submissionID)!.count
  return fixture.database.connection
    .query<
      { count: number },
      [string, string]
    >("SELECT count(*) AS count FROM publish_jobs WHERE kind = ? AND status = ?")
    .get(kind, status)!.count
}

async function expectCode(operation: () => unknown, code: SkillMarketControl.ProblemCode) {
  const error = await Promise.resolve()
    .then(operation)
    .then(
      () => undefined,
      (failure: unknown) => failure,
    )
  expect(error).toBeInstanceOf(SkillMarketSecurityError)
  if (!(error instanceof SkillMarketSecurityError)) throw error
  expect(error.code).toBe(code)
}
