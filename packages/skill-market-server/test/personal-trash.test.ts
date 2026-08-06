import { afterEach, describe, expect, test } from "bun:test"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { createPersonalTrash } from "../src/personal-trash"
import type { Principal } from "../src/security"
import { SkillMarketSecurityError } from "../src/security"
import { createSubmissions } from "../src/submissions"

const directories: string[] = []
const week = 7 * 24 * 60 * 60_000

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("personal Skill trash", () => {
  test("soft deletes only the owner's published personal Skill and restores strictly before seven days", async () => {
    const fixture = await trashFixture()
    const personal = await seedPersonal(fixture, "sub_personaltrash1", "private/personal/package.zip")
    const submissions = createSubmissions({ database: fixture.database, now: () => fixture.clock.value })
    const trash = createPersonalTrash({ database: fixture.database, now: () => fixture.clock.value })

    await expectCode(() => trash.deletePersonal(fixture.bob, personal.id, personal.version), "not-found")
    await expectCode(
      () => trash.deletePersonal(fixture.alice, personal.id, personal.version + 1),
      "submission-conflict",
    )

    const deleted = await trash.deletePersonal(fixture.alice, personal.id, personal.version)
    expect(deleted).toMatchObject({ id: personal.id, version: personal.version + 1 })
    expect(deleted.deletedAt).toBe("2026-08-04T00:00:00.000Z")
    expect(deleted.purgeAfter).toBe("2026-08-11T00:00:00.000Z")
    expect((await trash.list(fixture.alice)).map((item) => item.id)).toEqual([personal.id])
    expect(await trash.list(fixture.bob)).toEqual([])
    expect(
      (await submissions.listOwn(fixture.alice, { target: "personal", page: 1, limit: 30 })).items,
    ).toEqual([])
    await expect(submissions.getOwn(fixture.alice, personal.id)).rejects.toThrow("not found")
    await expect(submissions.personalPackage(fixture.alice, personal.id)).rejects.toThrow("not found")
    await expect(
      submissions.promote(fixture.alice, personal.id, {
        idempotencyKey: "trash-promotion",
        expectedVersion: deleted.version,
        target: "company",
      }),
    ).rejects.toThrow("not found")

    fixture.clock.value += week - 1
    expect(await trash.restorePersonal(fixture.alice, personal.id, deleted.version)).toMatchObject({
      id: personal.id,
      version: deleted.version + 1,
    })

    const deletedAgain = await trash.deletePersonal(fixture.alice, personal.id, deleted.version + 1)
    fixture.clock.value += week
    await expectCode(() => trash.restorePersonal(fixture.alice, personal.id, deletedAgain.version), "not-found")
    const audits = await fixture.database.read(async (c) =>
      c.all<{ action: string; before_json: string | null; after_json: string | null }>(
        "SELECT action, before_json, after_json FROM audit_events WHERE action IN ('personal-deleted', 'personal-restored') ORDER BY rowid",
      ),
    )
    expect(audits.map((audit) => audit.action)).toEqual(["personal-deleted", "personal-restored", "personal-deleted"])
    expect(JSON.stringify(audits)).not.toContain("private/")
    await fixture.database.close()
  })

  test("purges expired unreferenced artifacts and durably skips them on retry", async () => {
    const fixture = await trashFixture()
    const personal = await seedPersonal(fixture, "sub_personalpurge1", "private/purge/package.zip", true)
    const store = memoryStore([
      personal.packageKey,
      personal.iconKey!,
      "private/purge/manifest.json",
      "private/purge/scan.json",
    ])
    const trash = createPersonalTrash({ database: fixture.database, store, now: () => fixture.clock.value })
    const deleted = await trash.deletePersonal(fixture.alice, personal.id, personal.version)
    fixture.clock.value = Date.parse(deleted.purgeAfter)

    const concurrent = await Promise.all([trash.purgeExpiredPersonal(), trash.purgeExpiredPersonal()])
    expect(concurrent.flatMap((result) => result.purged)).toEqual([personal.id])
    expect(store.deleted.sort()).toEqual(
      [personal.packageKey, personal.iconKey!, "private/purge/manifest.json", "private/purge/scan.json"].sort(),
    )
    expect(await trash.purgeExpiredPersonal()).toEqual({ purged: [] })
    expect(store.deleted).toHaveLength(4)
    expect(
      (
        await fixture.database.read(async (c) =>
          c.get<{ artifacts_purged_at: number | null }>(
            "SELECT artifacts_purged_at FROM submissions WHERE id = ?",
            [personal.id],
          ),
        )
      )?.artifacts_purged_at,
    ).toBe(fixture.clock.value)
    await fixture.database.close()
  })

  test("preserves revision and restricted publication objects and retries an object deletion failure", async () => {
    const fixture = await trashFixture()
    const shared = await seedPersonal(fixture, "sub_personalshared1", "private/shared/package.zip")
    await seedRevisionReference(fixture, "sub_restrictedref1", shared.packageKey)
    const published = await seedPersonal(fixture, "sub_personalshared2", "private/published/package.zip")
    await seedRestrictedReference(fixture, "sub_restrictedref2", published.packageKey)
    const partial = await seedPersonal(fixture, "sub_personalpartial1", "private/partial/package.zip")
    const publicCopy = "skill-market/community/public-copy/package.zip"
    const sharedManifest = "private/shared/manifest.json"
    const sharedScan = "private/shared/scan.json"
    const store = memoryStore([
      shared.packageKey,
      sharedManifest,
      sharedScan,
      published.packageKey,
      partial.packageKey,
      "private/partial/manifest.json",
      "private/partial/scan.json",
      publicCopy,
    ])
    store.failOnce.add("private/partial/scan.json")
    const trash = createPersonalTrash({ database: fixture.database, store, now: () => fixture.clock.value })
    for (const item of [shared, published, partial])
      await trash.deletePersonal(fixture.alice, item.id, item.version)
    fixture.clock.value += week

    await expect(trash.purgeExpiredPersonal()).rejects.toThrow("delete failed")
    expect(store.deleted).not.toContain(shared.packageKey)
    expect(store.deleted).not.toContain(sharedManifest)
    expect(store.deleted).not.toContain(sharedScan)
    expect(store.deleted).not.toContain(published.packageKey)
    expect(
      (
        await fixture.database.read(async (c) =>
          c.get<{ artifacts_purged_at: number | null }>(
            "SELECT artifacts_purged_at FROM submissions WHERE id = ?",
            [partial.id],
          ),
        )
      )?.artifacts_purged_at,
    ).toBeNull()

    expect((await trash.purgeExpiredPersonal()).purged.sort()).toEqual([shared.id, published.id, partial.id].sort())
    expect(store.deleted).not.toContain(shared.packageKey)
    expect(store.deleted).not.toContain(published.packageKey)
    expect(store.objects.has(shared.packageKey)).toBe(true)
    expect(store.objects.has(sharedManifest)).toBe(true)
    expect(store.objects.has(sharedScan)).toBe(true)
    expect(store.objects.has(published.packageKey)).toBe(true)
    expect(store.objects.has(publicCopy)).toBe(true)
    await fixture.database.close()
  })
})

async function trashFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-personal-trash-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const clock = { value: Date.parse("2026-08-04T00:00:00.000Z") }
  await database.transaction(async (c) =>
    c.run(
      `INSERT INTO users (employee_id, display_name, email, created_at, last_login_at)
       VALUES ('alice', 'ALICE', 'alice@example.com', ?, ?), ('bob', 'BOB', 'bob@example.com', ?, ?)`,
      [clock.value, clock.value, clock.value, clock.value],
    ),
  )
  return { database, clock, alice: principal("alice"), bob: principal("bob") }
}

async function seedPersonal(
  fixture: Awaited<ReturnType<typeof trashFixture>>,
  id: SkillMarketControl.SubmissionID,
  packageKey: string,
  icon = false,
) {
  const iconKey = icon ? packageKey.replace("package.zip", "icon.png") : undefined
  await fixture.database.transaction(async (c) => {
    await c.run(
      `INSERT INTO submissions
        (id, skill_id, owner_employee_id, target_version, status, current_revision, version, created_at, updated_at, target_scope)
       VALUES (?, ?, 'alice', '1.0.0', 'published', 1, 2, ?, ?, 'personal')`,
      [id, id.replace("sub_", "skill-"), fixture.clock.value, fixture.clock.value],
    )
    await c.run(
      `INSERT INTO submission_revisions
        (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json,
         private_icon_json, manifest_json, scan_json, validation_errors_json, validation_completed_at, created_at)
       VALUES (?, 1, ?, ?, 100, ?, ?, ?, ?, '[]', ?, ?)`,
      [
        id,
        packageKey,
        "a".repeat(64),
        JSON.stringify({
          version: "1.0.0",
          displayName: id,
          description: "Personal Skill",
          category: "Development",
          tags: ["tools"],
          license: "MIT",
          requiresApiKey: false,
          changeNotes: "Initial",
        }),
        iconKey ? JSON.stringify({ key: iconKey, sha256: "b".repeat(64), size: 10, mime: "image/png" }) : null,
        JSON.stringify({ packageSha256: "a".repeat(64), packageSize: 100, files: [] }),
        JSON.stringify({ risk: "safe", reasons: [], evidence: [], scannedAt: "2026-08-04T00:00:00.000Z" }),
        fixture.clock.value,
        fixture.clock.value,
      ],
    )
  })
  return { id, version: 2, packageKey, iconKey }
}

async function seedRevisionReference(
  fixture: Awaited<ReturnType<typeof trashFixture>>,
  id: SkillMarketControl.SubmissionID,
  packageKey: string,
) {
  await fixture.database.transaction(async (c) => {
    await c.run(
      `INSERT INTO submissions
        (id, skill_id, owner_employee_id, target_version, status, current_revision, version, created_at, updated_at, target_scope)
       VALUES (?, ?, 'alice', '1.0.0', 'published', 1, 2, ?, ?, 'company')`,
      [id, id.replace("sub_", "skill-"), fixture.clock.value, fixture.clock.value],
    )
    await c.run(
      `INSERT INTO submission_revisions
        (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json, created_at)
       VALUES (?, 1, ?, ?, 100, ?, ?)`,
      [
        id,
        packageKey,
        "a".repeat(64),
        JSON.stringify({
          version: "1.0.0",
          displayName: id,
          description: "Shared Skill",
          category: "Development",
          tags: ["tools"],
          license: "MIT",
          requiresApiKey: false,
          changeNotes: "Initial",
        }),
        fixture.clock.value,
      ],
    )
  })
}

async function seedRestrictedReference(
  fixture: Awaited<ReturnType<typeof trashFixture>>,
  id: SkillMarketControl.SubmissionID,
  packageKey: string,
) {
  await seedRevisionReference(fixture, id, `private/reference/${id}/package.zip`)
  await fixture.database.transaction(async (c) =>
    c.run(
      `INSERT INTO restricted_publications
        (id, submission_id, skill_id, owner_employee_id, version, scope, department_id, package_key, package_sha256,
         package_size, metadata_json, status, row_version, created_at, updated_at)
       VALUES (?, ?, ?, 'alice', '1.0.0', 'groups', NULL, ?, ?, 100, '{}', 'published', 1, ?, ?)`,
      [
        `pub_${id.slice(4)}`,
        id,
        id.replace("sub_", "skill-"),
        packageKey,
        "a".repeat(64),
        fixture.clock.value,
        fixture.clock.value,
      ],
    ),
  )
}

function principal(employeeID: string): Principal {
  return {
    session: {
      user: { employeeID, displayName: employeeID.toUpperCase(), email: `${employeeID}@example.com` },
      roles: [],
      csrfToken: "a".repeat(43),
      createdAt: "2026-08-04T00:00:00.000Z",
      absoluteExpiresAt: "2026-08-05T00:00:00.000Z",
      idleExpiresAt: "2026-08-04T01:00:00.000Z",
    },
    csrfHash: "b".repeat(64),
  }
}

function memoryStore(keys: string[]) {
  const objects = new Set(keys)
  const deleted: string[] = []
  const failOnce = new Set<string>()
  return {
    objects,
    deleted,
    failOnce,
    async delete(key: string) {
      if (failOnce.delete(key)) throw new Error(`delete failed: ${key}`)
      deleted.push(key)
      objects.delete(key)
    },
  }
}

async function expectCode(operation: () => unknown, code: SkillMarketControl.ProblemCode) {
  try {
    await operation()
  } catch (error) {
    expect(error).toBeInstanceOf(SkillMarketSecurityError)
    if (!(error instanceof SkillMarketSecurityError)) throw error
    expect(error.code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}
