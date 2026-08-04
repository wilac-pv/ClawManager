import { afterEach, describe, expect, test } from "bun:test"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { canReadRestricted } from "../src/audience"
import type { Principal } from "../src/security"
import { SkillMarketSecurityError } from "../src/security"
import { assertSubmissionTransition, createSubmissions } from "../src/submissions"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("submission lifecycle", () => {
  test("allows only the approved submission status transitions", () => {
    const allowed = new Set([
      "validating:validation_failed",
      "validating:pending_review",
      "validation_failed:validating",
      "pending_review:changes_requested",
      "pending_review:rejected",
      "pending_review:publishing",
      "changes_requested:validating",
      "publishing:publish_failed",
      "publishing:published",
      "publish_failed:publishing",
    ])

    SkillMarketControl.SubmissionStatus.literals.forEach((from) =>
      SkillMarketControl.SubmissionStatus.literals.forEach((to) => {
        const transition = () => assertSubmissionTransition(from, to)
        if (allowed.has(`${from}:${to}`)) {
          expect(transition()).toBe(to)
          return
        }
        expect(transition).toThrow("submission status transition")
      }),
    )
  })

  test("persists validation and corrected revisions as monotonic atomic transitions", async () => {
    const fixture = await submissionFixture()
    const queued: Array<{ submissionID: string; revision: number }> = []
    const submissions = createSubmissions({
      database: fixture.database,
      now: () => fixture.clock.value,
      onValidationReady: (work) => {
        queued.push(work)
      },
    })
    const first = upload("weather-tools", "1.0.0", "first", true)

    const created = await submissions.create(fixture.alice, { idempotencyKey: "create-1", ...first })
    expect(created.submission).toMatchObject({
      id: first.submissionID,
      skillID: "weather-tools",
      targetVersion: "1.0.0",
      status: "validating",
      currentRevision: 1,
      version: 1,
      risk: "unknown",
    })
    expect(queued).toEqual([{ submissionID: created.submission.id, revision: 1 }])
    expect(
      fixture.database.connection
        .query<
          { private_icon_json: string | null },
          [string]
        >("SELECT private_icon_json FROM submission_revisions WHERE submission_id = ? AND revision_number = 1")
        .get(created.submission.id)?.private_icon_json,
    ).toBe(JSON.stringify(first.icon))

    const failed = submissions.completeValidation(
      validation(first, created.submission.id, 1, [
        { code: "likely-credential", message: "Archive appears to contain a credential" },
      ]),
    )
    expect(failed.submission).toMatchObject({ status: "validation_failed", currentRevision: 1, version: 2 })

    fixture.clock.value += 1_000
    const second = upload("weather-tools", "1.0.0", "second")
    const revised = await submissions.addRevision(fixture.alice, created.submission.id, {
      idempotencyKey: "revision-1",
      expectedVersion: 2,
      metadata: second.metadata,
      package: second.package,
    })
    expect(revised.submission).toMatchObject({ status: "validating", currentRevision: 2, version: 3 })
    expect(queued).toEqual([
      { submissionID: created.submission.id, revision: 1 },
      { submissionID: created.submission.id, revision: 2 },
    ])

    const completed = submissions.completeValidation(validation(second, created.submission.id, 2))
    expect(completed.submission).toMatchObject({ status: "pending_review", currentRevision: 2, version: 4 })
    expect(
      fixture.database.connection
        .query<
          { revision_number: number; validation_completed_at: number | null },
          []
        >("SELECT revision_number, validation_completed_at FROM submission_revisions ORDER BY revision_number")
        .all(),
    ).toEqual([
      { revision_number: 1, validation_completed_at: Date.parse("2026-07-15T00:00:00.000Z") },
      { revision_number: 2, validation_completed_at: fixture.clock.value },
    ])
    const audits = fixture.database.connection
      .query<
        { action: string; before_json: string | null },
        []
      >("SELECT action, before_json FROM audit_events ORDER BY created_at, rowid")
      .all()
    expect(audits.every((audit) => Schema.is(SkillMarketControl.AuditAction)(audit.action))).toBe(true)
    expect(audits).toEqual([
      { action: "submission-created", before_json: null },
      { action: "validation-failed", before_json: JSON.stringify({ status: "validating", revision: 1 }) },
      {
        action: "revision-uploaded",
        before_json: JSON.stringify({ status: "validation_failed", revision: 1 }),
      },
      {
        action: "validation-succeeded",
        before_json: JSON.stringify({ status: "validating", revision: 2 }),
      },
    ])

    fixture.database.close()
  })

  test("enforces permanent ownership and strictly increasing canonical SemVer", async () => {
    const fixture = await submissionFixture()
    seedPublishedSkill(fixture, "owned-skill", "1.2.3", "alice")
    const submissions = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })

    await expectCode(
      () => submissions.create(fixture.bob, { idempotencyKey: "bob-owned", ...upload("owned-skill", "2.0.0") }),
      "skill-owned-by-another-user",
    )
    await expectCode(
      () => submissions.create(fixture.alice, { idempotencyKey: "bad-semver", ...upload("new-skill", "01.0.0") }),
      "invalid-request",
    )
    await expectCode(
      () => submissions.create(fixture.alice, { idempotencyKey: "same-version", ...upload("owned-skill", "1.2.3") }),
      "submission-conflict",
    )
    await expectCode(
      () => submissions.create(fixture.alice, { idempotencyKey: "lower-version", ...upload("owned-skill", "1.2.2") }),
      "submission-conflict",
    )

    const higher = await submissions.create(fixture.alice, {
      idempotencyKey: "higher-version",
      ...upload("owned-skill", "1.2.4-alpha.10"),
    })
    expect(higher.submission.targetVersion).toBe("1.2.4-alpha.10")

    fixture.database.close()
  })

  test("limits each employee to five active submissions and twenty upload attempts per day", async () => {
    const activeFixture = await submissionFixture()
    const active = createSubmissions({ database: activeFixture.database, now: () => activeFixture.clock.value })
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        active.create(activeFixture.alice, {
          idempotencyKey: `active-${index}`,
          ...upload(`active-${index}`, "1.0.0"),
        }),
      ),
    )
    await expectCode(
      () => active.create(activeFixture.alice, { idempotencyKey: "active-6", ...upload("active-6", "1.0.0") }),
      "upload-rate-limited",
    )
    activeFixture.database.close()

    const dailyFixture = await submissionFixture()
    seedUploadAttempts(dailyFixture, 20)
    const daily = createSubmissions({ database: dailyFixture.database, now: () => dailyFixture.clock.value })
    await expectCode(
      () => daily.create(dailyFixture.alice, { idempotencyKey: "daily-21", ...upload("daily-21", "1.0.0") }),
      "upload-rate-limited",
    )
    dailyFixture.database.close()
  })

  test("replays idempotent responses and rejects reuse with another payload", async () => {
    const fixture = await submissionFixture()
    const queued: Array<{ submissionID: string; revision: number }> = []
    const submissions = createSubmissions({
      database: fixture.database,
      now: () => fixture.clock.value,
      onValidationReady: (work) => {
        queued.push(work)
      },
    })
    const input = { idempotencyKey: "stable-key", ...upload("idempotent", "1.0.0") }

    const first = await submissions.create(fixture.alice, input)
    const replay = await submissions.create(fixture.alice, input)
    expect(replay).toEqual(first)
    const relocated = await submissions.create(fixture.alice, {
      ...input,
      submissionID: `sub_${"b".repeat(16)}`,
      package: { ...input.package, key: "private/retry-location/package.zip" },
    })
    expect(relocated).toEqual(first)
    const reordered = await submissions.create(fixture.alice, {
      idempotencyKey: input.idempotencyKey,
      submissionID: input.submissionID,
      verifiedSkillID: input.verifiedSkillID,
      metadata: {
        changeNotes: input.metadata.changeNotes,
        requiresApiKey: input.metadata.requiresApiKey,
        license: input.metadata.license,
        tags: input.metadata.tags,
        category: input.metadata.category,
        description: input.metadata.description,
        displayName: input.metadata.displayName,
        version: input.metadata.version,
      },
      package: { size: input.package.size, sha256: input.package.sha256, key: input.package.key },
    })
    expect(reordered).toEqual(first)
    expect(queued).toEqual([{ submissionID: first.submission.id, revision: 1 }])
    expect(rowCount(fixture, "submissions")).toBe(1)
    expect(rowCount(fixture, "submission_revisions")).toBe(1)
    await expectCode(
      () =>
        submissions.create(fixture.alice, {
          ...input,
          metadata: metadata("1.0.0", "changed display name"),
        }),
      "submission-conflict",
    )

    submissions.completeValidation(
      validation(input, first.submission.id, 1, [{ code: "invalid", message: "Please upload a new archive" }]),
    )
    const revision = await submissions.addRevision(fixture.alice, first.submission.id, {
      idempotencyKey: "stable-key",
      expectedVersion: 2,
      metadata: input.metadata,
      package: upload("idempotent", "1.0.0", "revision").package,
    })
    expect(revision.submission.currentRevision).toBe(2)
    const idempotency = fixture.database.connection
      .query<
        { created_at: number; expires_at: number },
        [string]
      >("SELECT created_at, expires_at FROM idempotency_keys WHERE idempotency_key = ? AND route = 'submissions:create'")
      .get(input.idempotencyKey)!
    expect(idempotency.expires_at - idempotency.created_at).toBe(24 * 60 * 60 * 1_000)
    fixture.clock.value = idempotency.expires_at + 1
    const reused = await submissions.create(fixture.alice, {
      idempotencyKey: input.idempotencyKey,
      ...upload("idempotent-after-expiry", "1.0.0"),
    })
    expect(reused.submission.id).not.toBe(first.submission.id)

    fixture.database.close()
  })

  test("rolls back partial writes and hides every other employee's private submissions", async () => {
    const fixture = await submissionFixture()
    fixture.database.connection.exec(
      `CREATE TRIGGER fail_revision_insert BEFORE INSERT ON submission_revisions
       BEGIN SELECT RAISE(ABORT, 'injected revision failure'); END;`,
    )
    const brokenCreate = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })
    const createFailure = await brokenCreate
      .create(fixture.alice, { idempotencyKey: "broken-key", ...upload("broken", "1.0.0") })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(String(createFailure)).toContain("injected revision failure")
    expect(rowCount(fixture, "submissions")).toBe(0)
    expect(rowCount(fixture, "submission_revisions")).toBe(0)
    expect(rowCount(fixture, "audit_events")).toBe(0)
    expect(rowCount(fixture, "idempotency_keys")).toBe(0)
    fixture.database.connection.exec("DROP TRIGGER fail_revision_insert")

    const submissions = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })
    const alice = await submissions.create(fixture.alice, {
      idempotencyKey: "alice-private",
      ...upload("alice-private", "1.0.0"),
    })
    const bob = await submissions.create(fixture.bob, {
      idempotencyKey: "bob-private",
      ...upload("bob-private", "1.0.0"),
    })
    fixture.database.connection.exec(
      `CREATE TRIGGER fail_validation_status BEFORE UPDATE OF status ON submissions
       BEGIN SELECT RAISE(ABORT, 'injected validation failure'); END;`,
    )
    const brokenValidation = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })
    expect(() => brokenValidation.completeValidation(validation(alice, alice.submission.id, 1))).toThrow(
      "injected validation failure",
    )
    expect(
      fixture.database.connection
        .query<
          { manifest_json: string | null },
          [string]
        >("SELECT manifest_json FROM submission_revisions WHERE submission_id = ? AND revision_number = 1")
        .get(alice.submission.id)?.manifest_json,
    ).toBeNull()
    expect(submissions.getOwn(fixture.alice, alice.submission.id).status).toBe("validating")

    const page = submissions.listOwn(fixture.alice, { page: 1, limit: 50 })
    expect(page.total).toBe(1)
    expect(page.items.map((submission) => submission.id)).toEqual([alice.submission.id])
    expect(() => submissions.getOwn(fixture.alice, bob.submission.id)).toThrow("submission was not found")

    fixture.database.close()
  })

  test("keeps published submissions immutable and creates a new submission for a higher version", async () => {
    const fixture = await submissionFixture()
    const submissions = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })
    const firstUpload = upload("versioned", "1.0.0")
    const first = await submissions.create(fixture.alice, { idempotencyKey: "version-1", ...firstUpload })
    submissions.completeValidation(validation(firstUpload, first.submission.id, 1))
    fixture.database.transaction((connection) => {
      connection.run("UPDATE submissions SET status = 'published', version = version + 1 WHERE id = ?", [
        first.submission.id,
      ])
      connection.run(
        "UPDATE community_skills SET current_version = '1.0.0', current_submission_id = ?, public_status = 'published' WHERE skill_id = 'versioned'",
        [first.submission.id],
      )
    })

    await expectCode(
      () =>
        submissions.addRevision(fixture.alice, first.submission.id, {
          idempotencyKey: "published-revision",
          expectedVersion: 3,
          metadata: firstUpload.metadata,
          package: firstUpload.package,
        }),
      "submission-conflict",
    )
    const second = await submissions.create(fixture.alice, {
      idempotencyKey: "version-2",
      ...upload("versioned", "1.1.0"),
    })
    expect(second.submission.id).not.toBe(first.submission.id)
    expect(second.submission).toMatchObject({ skillID: "versioned", targetVersion: "1.1.0", status: "validating" })

    fixture.database.connection.run("UPDATE submissions SET status = 'rejected' WHERE id = ?", [second.submission.id])
    const replacement = await submissions.create(fixture.alice, {
      idempotencyKey: "version-2-replacement",
      ...upload("versioned", "1.1.0", "replacement"),
    })
    expect(replacement.submission.targetVersion).toBe("1.1.0")

    fixture.database.close()
  })

  test("makes a scanned personal upload immediately available only to its owner", async () => {
    const fixture = await submissionFixture()
    const submissions = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })
    const aliceUpload = upload("private-helper", "1.0.0", "alice")
    const bobUpload = upload("private-helper", "1.0.0", "bob")

    const alice = await submissions.create(fixture.alice, {
      target: "personal",
      idempotencyKey: "personal-alice",
      ...aliceUpload,
    })
    const bob = await submissions.create(fixture.bob, {
      target: "personal",
      idempotencyKey: "personal-bob",
      ...bobUpload,
    })
    const ready = submissions.completeValidation(validation(aliceUpload, alice.submission.id, 1))

    expect(ready.submission).toMatchObject({ target: "personal", status: "published", risk: "safe" })
    expect(
      fixture.database.connection.query<{ count: number }, []>("SELECT count(*) AS count FROM community_skills").get()
        ?.count,
    ).toBe(0)
    expect(submissions.listOwn(fixture.alice, { target: "personal", page: 1, limit: 30 }).items).toHaveLength(1)
    expect(submissions.listOwn(fixture.alice, { target: "company", page: 1, limit: 30 }).items).toHaveLength(0)
    expect(submissions.personalPackage(fixture.alice, alice.submission.id)).toEqual({
      key: aliceUpload.package.key,
      sha256: aliceUpload.package.sha256,
      size: aliceUpload.package.size,
      filename: "private-helper-1.0.0.zip",
    })
    expect(() => submissions.personalPackage(fixture.bob, alice.submission.id)).toThrow("not found")
    expect(bob.submission.status).toBe("validating")

    fixture.database.close()
  })

  test("captures trusted department and owned active group audiences", async () => {
    const fixture = await submissionFixture()
    seedGroup(fixture, "grp_aurora123", "alice", "active", ["alice", "bob"])
    seedGroup(fixture, "grp_atlas1234", "alice", "active", ["alice"])
    seedGroup(fixture, "grp_disabled1", "alice", "disabled", ["alice"])
    const submissions = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })

    const teamUpload = upload("team-helper", "1.0.0")
    const team = await submissions.create(fixture.alice, {
      ...teamUpload,
      idempotencyKey: "team-audience",
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_atlas1234", "grp_aurora123", "grp_aurora123"] },
    })
    expect(team.submission).toMatchObject({
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_atlas1234", "grp_aurora123"] },
    })
    expect(submissions.completeValidation(validation(teamUpload, team.submission.id, 1)).submission.status).toBe(
      "pending_review",
    )

    const departmentUpload = upload("department-helper", "1.0.0")
    const department = await submissions.create(fixture.alice, {
      ...departmentUpload,
      idempotencyKey: "department-audience",
      target: "department",
      audience: { scope: "department" },
    })
    expect(department.submission).toMatchObject({
      target: "department",
      audience: { scope: "department", department: { id: "engineering", name: "Engineering" } },
    })
    expect(
      submissions.completeValidation(validation(departmentUpload, department.submission.id, 1)).submission.status,
    ).toBe("pending_review")

    await expectCode(
      () =>
        submissions.create(fixture.bob, {
          ...upload("member-blocked", "1.0.0"),
          idempotencyKey: "member-blocked",
          target: "groups",
          audience: { scope: "groups", groupIDs: ["grp_aurora123"] },
        }),
      "forbidden",
    )
    await expectCode(
      () =>
        submissions.create(fixture.alice, {
          ...upload("disabled-blocked", "1.0.0"),
          idempotencyKey: "disabled-blocked",
          target: "groups",
          audience: { scope: "groups", groupIDs: ["grp_disabled1"] },
        }),
      "forbidden",
    )
    await expectCode(
      () =>
        submissions.create(fixture.noDepartment, {
          ...upload("department-blocked", "1.0.0"),
          idempotencyKey: "department-blocked",
          target: "department",
          audience: { scope: "department" },
        }),
      "forbidden",
    )

    fixture.database.close()
  })

  test("promotes a verified personal package through a distinct freshly scanned submission", async () => {
    const fixture = await submissionFixture()
    const queued: Array<{ submissionID: string; revision: number }> = []
    const submissions = createSubmissions({
      database: fixture.database,
      now: () => fixture.clock.value,
      onValidationReady: (work) => {
        queued.push(work)
      },
    })
    const uploaded = upload("personal-promotion", "1.0.0")
    const personal = await submissions.create(fixture.alice, {
      ...uploaded,
      idempotencyKey: "personal-source",
      target: "personal",
    })
    const ready = submissions.completeValidation(validation(uploaded, personal.submission.id, 1))
    queued.splice(0)

    const promoted = await submissions.promote(fixture.alice, personal.submission.id, {
      idempotencyKey: "promote-personal",
      expectedVersion: ready.submission.version,
      target: "department",
      audience: { scope: "department" },
    })
    expect(promoted.submission).toMatchObject({
      skillID: "personal-promotion",
      targetVersion: "1.0.0",
      target: "department",
      audience: { scope: "department", department: { id: "engineering", name: "Engineering" } },
      status: "validating",
      currentRevision: 1,
    })
    expect(promoted.submission.id).not.toBe(personal.submission.id)
    expect(submissions.getOwn(fixture.alice, personal.submission.id)).toMatchObject({
      id: personal.submission.id,
      target: "personal",
      status: "published",
    })
    expect(queued).toEqual([{ submissionID: promoted.submission.id, revision: 1 }])
    expect(
      fixture.database.connection
        .query<
          {
            private_package_key: string
            package_sha256: string
            manifest_json: string | null
            scan_json: string | null
          },
          [string]
        >(
          `SELECT private_package_key, package_sha256, manifest_json, scan_json
           FROM submission_revisions WHERE submission_id = ? AND revision_number = 1`,
        )
        .get(promoted.submission.id),
    ).toEqual({
      private_package_key: uploaded.package.key,
      package_sha256: uploaded.package.sha256,
      manifest_json: null,
      scan_json: null,
    })

    fixture.database.close()
  })

  test("versions audience changes without mutating the reviewed source snapshot", async () => {
    const fixture = await submissionFixture()
    seedGroup(fixture, "grp_aurora123", "alice", "active", ["alice"])
    seedGroup(fixture, "grp_atlas1234", "alice", "active", ["alice"])
    const submissions = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })
    const uploaded = upload("audience-change", "1.0.0")
    const source = await submissions.create(fixture.alice, {
      ...uploaded,
      idempotencyKey: "audience-source",
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_aurora123"] },
    })
    submissions.completeValidation(validation(uploaded, source.submission.id, 1))
    const publicationID = seedRestrictedPublication(fixture, source.submission.id)

    const changed = await submissions.changeAudience(fixture.alice, source.submission.id, {
      idempotencyKey: "audience-change",
      expectedVersion: 3,
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_atlas1234"] },
    })
    expect(changed.submission).toMatchObject({
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_atlas1234"] },
      status: "pending_review",
    })
    expect(changed.submission.id).not.toBe(source.submission.id)
    expect(
      fixture.database.connection
        .query<
          { group_id: string },
          [string]
        >("SELECT group_id FROM submission_group_targets WHERE submission_id = ? ORDER BY group_id")
        .all(source.submission.id),
    ).toEqual([{ group_id: "grp_aurora123" }])
    expect(
      fixture.database.connection
        .query<
          { group_id: string },
          [string]
        >("SELECT group_id FROM restricted_publication_groups WHERE publication_id = ? ORDER BY group_id")
        .all(publicationID),
    ).toEqual([{ group_id: "grp_aurora123" }])

    const racedUpload = upload("audience-race", "1.0.0")
    const racedSource = await submissions.create(fixture.alice, {
      ...racedUpload,
      idempotencyKey: "audience-race-source",
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_aurora123"] },
    })
    submissions.completeValidation(validation(racedUpload, racedSource.submission.id, 1))
    seedRestrictedPublication(fixture, racedSource.submission.id, "pub_audiencerace")
    await submissions.changeAudience(fixture.alice, racedSource.submission.id, {
      idempotencyKey: "audience-race-personal",
      expectedVersion: 3,
      target: "personal",
    })
    await expect(
      submissions.changeAudience(fixture.alice, racedSource.submission.id, {
        idempotencyKey: "audience-race-department",
        expectedVersion: 3,
        target: "department",
        audience: { scope: "department" },
      }),
    ).rejects.toThrow("audience change is already active")

    fixture.database.close()
  })

  test("authorizes restricted reads for owner, live department or group, and admin only", async () => {
    const fixture = await submissionFixture()
    seedGroup(fixture, "grp_aurora123", "alice", "active", ["alice", "bob"])
    const submissions = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })
    const groupUpload = upload("read-group", "1.0.0")
    const group = await submissions.create(fixture.alice, {
      ...groupUpload,
      idempotencyKey: "read-group",
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_aurora123"] },
    })
    submissions.completeValidation(validation(groupUpload, group.submission.id, 1))
    const groupPublication = seedRestrictedPublication(fixture, group.submission.id, "pub_readgroup1")

    expect(canReadRestricted(fixture.database.connection, fixture.alice, groupPublication)).toBe(true)
    expect(canReadRestricted(fixture.database.connection, fixture.bob, groupPublication)).toBe(true)
    expect(canReadRestricted(fixture.database.connection, fixture.noDepartment, groupPublication)).toBe(false)
    expect(
      canReadRestricted(
        fixture.database.connection,
        principal("no-department", undefined, ["admin"]),
        groupPublication,
      ),
    ).toBe(true)
    fixture.database.connection.run("UPDATE market_groups SET status = 'disabled' WHERE id = 'grp_aurora123'")
    expect(canReadRestricted(fixture.database.connection, fixture.bob, groupPublication)).toBe(false)
    expect(canReadRestricted(fixture.database.connection, fixture.alice, groupPublication)).toBe(true)

    const departmentUpload = upload("read-department", "1.0.0")
    const department = await submissions.create(fixture.alice, {
      ...departmentUpload,
      idempotencyKey: "read-department",
      target: "department",
      audience: { scope: "department" },
    })
    submissions.completeValidation(validation(departmentUpload, department.submission.id, 1))
    const departmentPublication = seedRestrictedPublication(fixture, department.submission.id, "pub_readdepart1")
    fixture.database.connection.run(
      "UPDATE users SET department_id = 'engineering' WHERE employee_id = 'no-department'",
    )
    expect(canReadRestricted(fixture.database.connection, fixture.noDepartment, departmentPublication)).toBe(true)
    fixture.database.connection.run("UPDATE users SET department_id = 'design' WHERE employee_id = 'no-department'")
    expect(canReadRestricted(fixture.database.connection, fixture.noDepartment, departmentPublication)).toBe(false)

    fixture.database.close()
  })

  test("reserves the existing public publisher for an approved company audience change", async () => {
    const fixture = await submissionFixture()
    seedGroup(fixture, "grp_aurora123", "alice", "active", ["alice"])
    const submissions = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })
    const uploaded = upload("company-change", "1.0.0")
    const source = await submissions.create(fixture.alice, {
      ...uploaded,
      idempotencyKey: "company-change-source",
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_aurora123"] },
    })
    submissions.completeValidation(validation(uploaded, source.submission.id, 1))
    seedRestrictedPublication(fixture, source.submission.id, "pub_company1234")

    const changed = await submissions.changeAudience(fixture.alice, source.submission.id, {
      idempotencyKey: "company-change-request",
      expectedVersion: 3,
      target: "company",
    })
    expect(changed.submission).toMatchObject({ target: "company", status: "pending_review" })
    expect(
      fixture.database.connection
        .query<
          { owner_employee_id: string; current_version: string | null },
          [string]
        >("SELECT owner_employee_id, current_version FROM community_skills WHERE skill_id = ?")
        .get("company-change"),
    ).toEqual({ owner_employee_id: "alice", current_version: null })

    fixture.database.close()
  })
})

async function submissionFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-submissions-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const clock = { value: Date.parse("2026-07-15T00:00:00.000Z") }
  database.transaction((connection) => {
    connection.run(
      `INSERT INTO departments (department_id, display_name, first_seen_at, last_seen_at)
       VALUES ('engineering', 'Engineering', ?, ?), ('design', 'Design', ?, ?)`,
      [clock.value, clock.value, clock.value, clock.value],
    )
    ;["alice", "bob", "no-department"].forEach((employeeID) =>
      connection.run(
        `INSERT INTO users (employee_id, display_name, email, department_id, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          employeeID,
          employeeID.toUpperCase(),
          `${employeeID}@example.com`,
          employeeID === "alice" ? "engineering" : employeeID === "bob" ? "design" : null,
          clock.value,
          clock.value,
        ],
      ),
    )
  })
  return {
    database,
    clock,
    alice: principal("alice", { id: "engineering", name: "Engineering" }),
    bob: principal("bob", { id: "design", name: "Design" }),
    noDepartment: principal("no-department"),
  }
}

function principal(
  employeeID: string,
  department?: SkillMarketControl.Department,
  roles: ReadonlyArray<SkillMarketControl.Role> = [],
): Principal {
  return {
    session: {
      user: {
        employeeID,
        displayName: employeeID.toUpperCase(),
        email: `${employeeID}@example.com`,
        ...(department ? { department } : {}),
      },
      roles,
      csrfToken: new Bun.CryptoHasher("sha256").update(`${employeeID}:csrf`).digest("base64url"),
      createdAt: "2026-07-15T00:00:00.000Z",
      absoluteExpiresAt: "2026-07-15T12:00:00.000Z",
      idleExpiresAt: "2026-07-15T02:00:00.000Z",
    },
    csrfHash: new Bun.CryptoHasher("sha256").update(`${employeeID}:csrf-hash`).digest("hex"),
  }
}

function seedGroup(
  fixture: Awaited<ReturnType<typeof submissionFixture>>,
  groupID: SkillMarketControl.GroupID,
  ownerEmployeeID: string,
  status: "active" | "disabled",
  members: ReadonlyArray<string>,
) {
  fixture.database.transaction((connection) => {
    connection.run(
      `INSERT INTO market_groups (id, name, owner_employee_id, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [groupID, groupID, ownerEmployeeID, status, fixture.clock.value, fixture.clock.value],
    )
    members.forEach((employeeID) =>
      connection.run(
        `INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at)
         VALUES (?, ?, ?, ?)`,
        [groupID, employeeID, ownerEmployeeID, fixture.clock.value],
      ),
    )
  })
}

function seedRestrictedPublication(
  fixture: Awaited<ReturnType<typeof submissionFixture>>,
  submissionID: string,
  publicationID = "pub_audience123",
) {
  fixture.database.transaction((connection) => {
    connection.run("UPDATE submissions SET status = 'published', version = 3 WHERE id = ?", [submissionID])
    connection.run(
      `INSERT INTO restricted_publications
        (id, submission_id, skill_id, owner_employee_id, version, scope, department_id, package_key, package_sha256,
         package_size, metadata_json, status, row_version, created_at, updated_at)
       SELECT ?, submissions.id, submissions.skill_id, submissions.owner_employee_id, submissions.target_version,
              submissions.target_scope, submissions.target_department_id, submission_revisions.private_package_key,
              submission_revisions.package_sha256,
              submission_revisions.package_size, submission_revisions.metadata_json, 'published', 1, ?, ?
       FROM submissions
       INNER JOIN submission_revisions
         ON submission_revisions.submission_id = submissions.id
        AND submission_revisions.revision_number = submissions.current_revision
       WHERE submissions.id = ?`,
      [publicationID, fixture.clock.value, fixture.clock.value, submissionID],
    )
    connection.run(
      `INSERT INTO restricted_publication_groups (publication_id, group_id)
       SELECT ?, group_id FROM submission_group_targets WHERE submission_id = ?`,
      [publicationID, submissionID],
    )
  })
  return publicationID
}

function upload(skillID: string, version: string, salt = "package", withIcon = false) {
  const sha256 = new Bun.CryptoHasher("sha256").update(`${skillID}:${version}:${salt}`).digest("hex")
  const submissionID = `sub_${sha256.slice(0, 16)}`
  const icon = {
    key: `private/${skillID}/${salt}.png`,
    sha256: new Bun.CryptoHasher("sha256").update(`${skillID}:${salt}:icon`).digest("hex"),
    size: 256,
    mime: "image/png" as const,
  }
  return {
    submissionID,
    verifiedSkillID: skillID,
    metadata: metadata(version),
    package: { key: `private/${submissionID}/${salt}.zip`, sha256, size: 100 },
    ...(withIcon ? { icon } : {}),
  }
}

function metadata(version: string, displayName = "Weather Tools") {
  return {
    version,
    displayName,
    description: "A useful submitted skill",
    category: "Development",
    tags: ["tools"],
    license: "MIT",
    requiresApiKey: false,
    changeNotes: "Initial community release",
  } as SkillMarketControl.SubmissionMetadata
}

function validation(
  uploaded: ReturnType<typeof upload> | SkillMarketControl.AcceptedSubmission,
  submissionID: string,
  revision: number,
  validationIssues: ReadonlyArray<SkillMarketControl.ValidationIssue> = [],
) {
  const source =
    "package" in uploaded ? uploaded : upload(uploaded.submission.skillID, uploaded.submission.targetVersion)
  return {
    submissionID,
    revision,
    manifest: {
      packageSha256: source.package.sha256,
      packageSize: source.package.size,
      files: [
        {
          path: "SKILL.md",
          sha256: new Bun.CryptoHasher("sha256").update("skill").digest("hex"),
          size: 100,
          mime: "text/markdown",
        },
      ],
    },
    scan: {
      risk: "safe" as const,
      reasons: [],
      evidence: [],
      scannedAt: "2026-07-15T00:00:00.000Z",
    },
    validationIssues,
  }
}

function seedPublishedSkill(
  fixture: Awaited<ReturnType<typeof submissionFixture>>,
  skillID: string,
  version: string,
  employeeID: string,
) {
  fixture.database.connection.run(
    `INSERT INTO community_skills
      (skill_id, owner_employee_id, current_version, public_status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'published', 1, ?, ?)`,
    [skillID, employeeID, version, fixture.clock.value, fixture.clock.value],
  )
}

function seedUploadAttempts(fixture: Awaited<ReturnType<typeof submissionFixture>>, count: number) {
  fixture.database.transaction((connection) =>
    Array.from({ length: count }, (_, index) => {
      const id = `sub_seed_${index.toString().padStart(8, "0")}`
      connection.run(
        `INSERT INTO submissions
          (id, skill_id, owner_employee_id, target_version, status, current_revision, version, created_at, updated_at)
         VALUES (?, ?, 'alice', '1.0.0', 'rejected', 1, 1, ?, ?)`,
        [id, `seed-${index}`, fixture.clock.value - index, fixture.clock.value - index],
      )
      connection.run(
        `INSERT INTO submission_revisions
          (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json, created_at)
         VALUES (?, 1, ?, ?, 100, ?, ?)`,
        [id, `private/${id}.zip`, "a".repeat(64), JSON.stringify(metadata("1.0.0")), fixture.clock.value - index],
      )
    }),
  )
}

function rowCount(fixture: Awaited<ReturnType<typeof submissionFixture>>, table: string) {
  if (!new Set(["submissions", "submission_revisions", "audit_events", "idempotency_keys"]).has(table))
    throw new Error("unsupported table")
  return fixture.database.connection.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count
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
