import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SqliteDatabase } from "../src/database"
import { createSecurity, type Principal } from "../src/security"
import { createSkillHubImportAdmin } from "../src/skillhub-import-admin"
import { createSkillHubImportStore } from "../src/skillhub-import-store"
import { createSkillHubEvaluationStore } from "../src/skillhub-evaluation-store"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("SkillHub import administration", () => {
  test("forbids anonymous and reviewer principals", async () => {
    const fixture = await adminFixture()

    expect(() => fixture.admin.status(principal([]))).toThrow("admin role")
    expect(() => fixture.admin.command(principal(["reviewer"]), { command: "pause" })).toThrow("admin role")

    await fixture.database.close()
  })

  test("audits all queue commands with pre-transition rejected errors", async () => {
    const fixture = await adminFixture()
    const generation = await fixture.imports.beginGeneration(2)
    await fixture.imports.recordPage(generation.id, 1, [listRecord("retry"), listRecord("rejected")])
    await fixture.imports.claim("worker", 2, 60_000)
    await fixture.imports.retry("worker", "retry", "download", "retry later", fixture.clock.value + 60_000)
    await fixture.imports.reject("worker", "rejected", "validation", "unsafe package")

    expect((await fixture.admin.command(principal(["admin"]), { command: "pause" })).state).toBe("paused")
    expect((await fixture.admin.command(principal(["admin"]), { command: "resume" })).state).toBe("running")
    expect((await fixture.admin.command(principal(["admin"]), { command: "retry-wait" })).pending).toBe(1)
    expect(
      (await fixture.admin.command(principal(["admin"]), { command: "retry-rejected", slugs: ["rejected"] })).rejected,
    ).toBe(0)

    const audit = (fixture.database as SqliteDatabase).connection
      .query<
        {
          action: string
          actor_employee_id: string
          object_type: string
          object_id: string
          before_json: string
          after_json: string
          request_id: string
        },
        []
      >(
        "SELECT action, actor_employee_id, object_type, object_id, before_json, after_json, request_id FROM audit_events ORDER BY rowid",
      )
      .all()
    expect(audit.map((event) => event.action)).toEqual([
      "skillhub-import-paused",
      "skillhub-import-resumed",
      "skillhub-import-retried",
      "skillhub-import-retried",
    ])
    expect(audit.every((event) => event.actor_employee_id === "admin" && event.object_type === "skillhub_import")).toBe(
      true,
    )
    expect(audit.every((event) => event.object_id === generation.id && event.request_id.startsWith("req_"))).toBe(true)
    expect(audit.every((event) => JSON.parse(event.before_json).counts && JSON.parse(event.after_json).counts)).toBe(
      true,
    )
    expect(JSON.parse(audit.at(-1)!.before_json).retriedRejected).toEqual([
      { slug: "rejected", code: "validation", summary: "unsafe package" },
    ])
    expect(
      (fixture.database as SqliteDatabase).connection
        .query<
          { error_code: string | null; error_summary: string | null },
          [string]
        >("SELECT error_code, error_summary FROM skillhub_import_items WHERE slug = ?")
        .get("rejected"),
    ).toEqual({ error_code: null, error_summary: null })

    await fixture.database.close()
  })

  test("rolls queue updates back when the append-only audit insert fails", async () => {
    const fixture = await adminFixture()
    await fixture.imports.beginGeneration(1)
    ;(fixture.database as SqliteDatabase).connection.exec(`
      CREATE TRIGGER reject_skillhub_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'skillhub-import-paused'
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END;
    `)

    await expect(fixture.admin.command(principal(["admin"]), { command: "pause" })).rejects.toThrow("audit unavailable")
    expect((await fixture.imports.progress()).state).toBe("running")

    await fixture.database.close()
  })

  test("rejects untargeted commands without auditing a completed generation", async () => {
    const fixture = await adminFixture()
    const generation = await fixture.imports.beginGeneration(1)
    ;(fixture.database as SqliteDatabase).connection.run(
      "UPDATE skillhub_generations SET state = 'completed', discovery_completed_at = ?, completed_at = ? WHERE id = ?",
      [fixture.clock.value, fixture.clock.value, generation.id],
    )

    for (const input of [{ command: "pause" }, { command: "resume" }, { command: "retry-wait" }] as const)
      expect(() => fixture.admin.command(principal(["admin"]), input)).toThrow("invalid")
    expect(
      (fixture.database as SqliteDatabase).connection.query<{ count: number }, []>("SELECT count(*) AS count FROM audit_events").get()
        ?.count,
    ).toBe(0)

    await fixture.database.close()
  })

  test("audits a selected retry against the generation reopened from completed", async () => {
    const fixture = await adminFixture()
    const generation = await fixture.imports.beginGeneration(1)
    await fixture.imports.recordPage(generation.id, 1, [listRecord("rejected")])
    await fixture.imports.claim("worker", 1, 60_000)
    await fixture.imports.reject("worker", "rejected", "validation", "unsafe package")
    ;(fixture.database as SqliteDatabase).connection.run(
      "UPDATE skillhub_generations SET state = 'completed', discovery_completed_at = ?, completed_at = ? WHERE id = ?",
      [fixture.clock.value, fixture.clock.value, generation.id],
    )

    expect((await fixture.admin.command(principal(["admin"]), { command: "retry-rejected", slugs: ["rejected"] })).state).toBe(
      "running",
    )
    expect(
      (fixture.database as SqliteDatabase).connection
        .query<{ object_id: string }, []>("SELECT object_id FROM audit_events WHERE action = 'skillhub-import-retried'")
        .get(),
    ).toEqual({ object_id: generation.id })

    await fixture.database.close()
  })

  test("rejects an unmatched selected retry without auditing a completed generation", async () => {
    const fixture = await adminFixture()
    const generation = await fixture.imports.beginGeneration(1)
    ;(fixture.database as SqliteDatabase).connection.run(
      "UPDATE skillhub_generations SET state = 'completed', discovery_completed_at = ?, completed_at = ? WHERE id = ?",
      [fixture.clock.value, fixture.clock.value, generation.id],
    )

    await expect(
      fixture.admin.command(principal(["admin"]), { command: "retry-rejected", slugs: ["missing"] }),
    ).rejects.toThrow("invalid")
    expect(
      (fixture.database as SqliteDatabase).connection.query<{ count: number }, []>("SELECT count(*) AS count FROM audit_events").get()
        ?.count,
    ).toBe(0)

    await fixture.database.close()
  })
})

async function adminFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skillhub-import-admin-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const clock = { value: Date.parse("2026-07-17T00:00:00.000Z") }
  const security = createSecurity({
    database,
    webOrigin: "http://127.0.0.1:4211",
    sessionIdleMilliseconds: 2 * 60 * 60 * 1_000,
    sessionAbsoluteMilliseconds: 12 * 60 * 60 * 1_000,
    now: () => clock.value,
  })
  ;(database as SqliteDatabase).connection.run(
    "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES ('admin', 'Operator', ?, ?)",
    [clock.value, clock.value],
  )
  const imports = createSkillHubImportStore({ database, now: () => clock.value })
  return {
    database,
    clock,
    imports,
    admin: createSkillHubImportAdmin({
      database,
      security,
      imports,
      evaluations: createSkillHubEvaluationStore({ database, now: () => clock.value }),
      now: () => clock.value,
    }),
  }
}

function principal(roles: ReadonlyArray<"reviewer" | "admin">): Principal {
  return {
    session: {
      user: { employeeID: roles.includes("admin") ? "admin" : "reviewer", displayName: "Operator" },
      roles,
      csrfToken: "_".repeat(43),
      createdAt: "2026-07-17T00:00:00.000Z",
      absoluteExpiresAt: "2026-07-17T12:00:00.000Z",
      idleExpiresAt: "2026-07-17T02:00:00.000Z",
    },
    csrfHash: "",
  }
}

function listRecord(slug: string) {
  return {
    category: "Developer Tools",
    description: `${slug} description`,
    downloads: 1,
    installs: 1,
    name: slug,
    ownerName: "SkillHub",
    score: 1,
    slug,
    source: "skillhub",
    stars: 1,
    subCategories: [],
    updated_at: Date.parse("2026-07-17T00:00:00.000Z"),
    version: "1.0.0",
  }
}
