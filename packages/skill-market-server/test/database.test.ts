import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { createSkillHubImportStore } from "../src/skillhub-import-store"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("control-plane database", () => {
  test("applies the schema once with WAL, foreign keys, constraints, and required indexes", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "market.db")
    const database = await openDatabase({
      databasePath: path,
      migrationBackupDirectory: join(directory, "backups"),
    })

    expect(database.connection.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe(
      "wal",
    )
    expect(database.connection.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1)
    expect(database.connection.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(4)
    expect(
      database.connection
        .query<{ name: string }, []>("PRAGMA table_info(submission_revisions)")
        .all()
        .map((column) => column.name),
    ).toContain("private_icon_json")

    const tables = database.connection
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name)
      .sort()
    expect(tables).toEqual(
      [
        "audit_events",
        "community_skills",
        "idempotency_keys",
        "login_attempts",
        "publish_jobs",
        "reviews",
        "role_assignments",
        "sessions",
        "skillhub_generations",
        "skillhub_import_items",
        "submission_revisions",
        "submissions",
        "users",
      ].sort(),
    )

    const indexes = database.connection
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name)
    expect(indexes).toContain("submissions_active_skill_version")
    expect(indexes).toContain("publish_jobs_active_submission")
    expect(indexes).toContain("submissions_owner_updated")
    expect(indexes).toContain("audit_events_created")
    expect(indexes).toContain("skillhub_import_queue")
    expect(indexes).toContain("skillhub_single_unsettled_generation")

    database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
      ["E000001", "Test User", 1, 1],
    )
    expect(() =>
      database.transaction((connection) => {
        connection.run("INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)", [
          "E000002",
          "Rolled Back",
          1,
          1,
        ])
        throw new Error("rollback")
      }),
    ).toThrow("rollback")
    expect(database.connection.query<{ count: number }, []>("SELECT count(*) AS count FROM users").get()?.count).toBe(1)
    expect(() =>
      database.connection.run("INSERT INTO role_assignments (employee_id, role, created_at) VALUES (?, ?, ?)", [
        "E999999",
        "reviewer",
        1,
      ]),
    ).toThrow()
    expect(() =>
      database.connection.run("INSERT INTO role_assignments (employee_id, role, created_at) VALUES (?, ?, ?)", [
        "E000001",
        "owner",
        1,
      ]),
    ).toThrow()

    database.connection.run(
      "INSERT INTO audit_events (id, action, object_type, object_id, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["audit-1", "submission.created", "submission", "submission-1", "request-1", 1],
    )
    expect(() => database.connection.run("UPDATE audit_events SET action = 'changed' WHERE id = 'audit-1'")).toThrow(
      "audit_events is append-only",
    )
    expect(() => database.connection.run("DELETE FROM audit_events WHERE id = 'audit-1'")).toThrow(
      "audit_events is append-only",
    )

    database.close()

    const reopened = await openDatabase({
      databasePath: path,
      migrationBackupDirectory: join(directory, "backups"),
    })
    expect(reopened.connection.query<{ count: number }, []>("SELECT count(*) AS count FROM users").get()?.count).toBe(1)
    expect(await readdir(join(directory, "backups"))).toEqual([])
    reopened.close()
  })

  test("backs up an existing database and rolls back a failed migration", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "market.db")
    const migrations = join(directory, "migrations")
    const backups = join(directory, "backups")
    await mkdir(migrations)
    await Bun.write(join(migrations, "001_initial.sql"), "CREATE TABLE stable (id TEXT PRIMARY KEY);")

    const initial = await openDatabase({
      databasePath: path,
      migrationBackupDirectory: backups,
      migrationDirectory: migrations,
    })
    initial.connection.run("INSERT INTO stable (id) VALUES ('preserved')")
    initial.close()

    await Bun.write(
      join(migrations, "002_broken.sql"),
      "CREATE TABLE should_rollback (id TEXT PRIMARY KEY); THIS IS NOT VALID SQL;",
    )
    const metrics: unknown[] = []
    const migrationError = await openDatabase({
      databasePath: path,
      migrationBackupDirectory: backups,
      migrationDirectory: migrations,
      emit: (metric) => metrics.push(metric),
    }).then(() => "", String)
    expect(migrationError).toContain('near "THIS": syntax error')

    const raw = new Database(path)
    expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1)
    expect(raw.query<{ count: number }, []>("SELECT count(*) AS count FROM stable").get()?.count).toBe(1)
    expect(
      raw
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'")
        .get()?.count,
    ).toBe(0)
    raw.close()

    const files = await readdir(backups)
    expect(files).toHaveLength(1)
    expect((await stat(join(backups, files[0]))).mode & 0o777).toBe(0o600)
    const backup = new Database(join(backups, files[0]), { readonly: true })
    expect(backup.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
    expect(backup.query<{ count: number }, []>("SELECT count(*) AS count FROM stable").get()?.count).toBe(1)
    expect(metrics).toEqual([{ skill_market_database_backup_result: { success: 1 } }])
    backup.close()
  })

  test("rechecks the version after concurrent startup obtains the exclusive transaction", async () => {
    const directory = await temporaryDirectory()
    const options = {
      databasePath: join(directory, "market.db"),
      migrationBackupDirectory: join(directory, "backups"),
    }
    const databases = await Promise.all([openDatabase(options), openDatabase(options)])

    expect(
      databases.map(
        (database) =>
          database.connection.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
      ),
    ).toEqual([4, 4])
    databases.forEach((database) => database.close())
  })

  test("upgrades persisted v3 imports without losing lifecycle or queue data", async () => {
    const directory = await temporaryDirectory()
    const migrations = join(directory, "v3-migrations")
    const path = join(directory, "market.db")
    const backups = join(directory, "backups")
    await mkdir(migrations)
    await Promise.all(
      ["001_control_plane.sql", "002_submission_icons.sql", "003_skillhub_import.sql"].map(async (file) =>
        Bun.write(join(migrations, file), Bun.file(join(import.meta.dir, "../migrations", file))),
      ),
    )
    const v3 = await openDatabase({ databasePath: path, migrationBackupDirectory: backups, migrationDirectory: migrations })
    v3.connection.run("PRAGMA ignore_check_constraints = ON")
    v3.connection.run(
      "INSERT INTO skillhub_generations (id, state, upstream_total, discovery_page, sweep, new_in_sweep, last_published_count, last_published_at, uploaded_bytes, started_at, updated_at, completed_at) VALUES ('draining', 'running', 4, 5, 1, 0, 2, 8, 20, 1, 10, 5), ('other-active', 'paused', 1, 1, 0, 1, 3, 9, 5, 2, 9, NULL), ('complete', 'completed', 1, 1, 1, 0, 9, 19, 10, 3, 20, 20)",
    )
    const insertItem =
      "INSERT INTO skillhub_import_items (slug, generation_id, upstream_version, upstream_updated_at, state, next_attempt_at, lease_owner, lease_expires_at, list_json, summary_json, detail_key, detail_sha256, error_code, error_summary, last_seen_generation, last_seen_sweep, created_at, updated_at) VALUES (?, ?, '1.0.0', 1, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, 1, 1, ?)"
    v3.connection.run(insertItem, [
      "mirror",
      "complete",
      "mirrored",
      null,
      null,
      null,
      "{}",
      "details/mirror.json",
      "a".repeat(64),
      null,
      null,
      "complete",
      20,
    ])
    v3.connection.run(insertItem, [
      "retry",
      "draining",
      "retry_wait",
      null,
      null,
      null,
      null,
      null,
      null,
      "unknown",
      "",
      "draining",
      11,
    ])
    v3.connection.run(insertItem, [
      "reject",
      "draining",
      "rejected",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "draining",
      12,
    ])
    v3.connection.run(insertItem, [
      "leased",
      "draining",
      "running",
      null,
      "worker",
      100,
      null,
      null,
      null,
      null,
      null,
      "draining",
      13,
    ])
    v3.connection.run(insertItem, [
      "other-pending",
      "other-active",
      "pending",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "other-active",
      14,
    ])
    v3.connection.run("PRAGMA ignore_check_constraints = OFF")
    v3.close()

    const upgraded = await openDatabase({ databasePath: path, migrationBackupDirectory: backups })
    expect(upgraded.connection.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(4)
    expect(
      upgraded.connection
        .query<
          {
            state: string
            discovery_completed_at: number | null
            completed_at: number | null
            last_published_count: number
          },
          [string]
        >(
          "SELECT state, discovery_completed_at, completed_at, last_published_count FROM skillhub_generations WHERE id = ?",
        )
        .get("other-active"),
    ).toEqual({ state: "running", discovery_completed_at: null, completed_at: null, last_published_count: 9 })
    expect(
      upgraded.connection
        .query<{ discovery_completed_at: number; completed_at: number }, [string]>(
          "SELECT discovery_completed_at, completed_at FROM skillhub_generations WHERE id = ?",
        )
        .get("complete"),
    ).toEqual({ discovery_completed_at: 20, completed_at: 20 })
    expect(
      upgraded.connection
        .query<{ state: string; mirrored_at: number }, [string]>(
          "SELECT state, mirrored_at FROM skillhub_import_items WHERE slug = ?",
        )
        .get("mirror"),
    ).toEqual({ state: "mirrored", mirrored_at: 20 })
    expect(
      upgraded.connection
        .query<{ next_attempt_at: number; error_code: string; error_summary: string }, [string]>(
          "SELECT next_attempt_at, error_code, error_summary FROM skillhub_import_items WHERE slug = ?",
        )
        .get("retry"),
    ).toEqual({ next_attempt_at: 11, error_code: "upstream", error_summary: "Migrated SkillHub import error" })
    expect(
      upgraded.connection
        .query<{ error_code: string; error_summary: string }, [string]>(
          "SELECT error_code, error_summary FROM skillhub_import_items WHERE slug = ?",
        )
        .get("reject"),
    ).toEqual({ error_code: "upstream", error_summary: "Migrated SkillHub import error" })
    expect(
      upgraded.connection
        .query<{ lease_owner: string; lease_expires_at: number }, [string]>(
          "SELECT lease_owner, lease_expires_at FROM skillhub_import_items WHERE slug = ?",
        )
        .get("leased"),
    ).toEqual({ lease_owner: "worker", lease_expires_at: 100 })
    expect(
      upgraded.connection
        .query<{ state: string }, [string]>("SELECT state FROM skillhub_generations WHERE id = ?")
        .get("draining"),
    ).toEqual({ state: "failed" })
    expect(
      upgraded.connection
        .query<{ generation_id: string; state: string }, [string]>(
          "SELECT generation_id, state FROM skillhub_import_items WHERE slug = ?",
        )
        .get("other-pending"),
    ).toEqual({ generation_id: "other-active", state: "pending" })
    const store = createSkillHubImportStore({ database: upgraded, now: () => 30 })
    expect(store.progress()).toMatchObject({
      state: "running",
      upstreamTotal: 1,
      pending: 1,
      running: 1,
      retryWait: 1,
      rejected: 1,
      lastPublishedAt: new Date(19).toISOString(),
    })
    expect(store.publicationCheckpoint()).toEqual({
      lastPublishedCount: 9,
      lastPublishedAt: new Date(19).toISOString(),
    })
    expect(store.recordPublication(10)).toBe(true)
    expect(
      upgraded.connection
        .query<{ id: string; last_published_count: number }, []>(
          "SELECT id, last_published_count FROM skillhub_generations WHERE last_published_count = 10",
        )
        .get(),
    ).toEqual({ id: "other-active", last_published_count: 10 })
    expect(
      store.seedLegacy([
        {
          slug: "legacy-after-upgrade",
          summary: {
            id: "legacy-after-upgrade",
            source: "skillhub",
            sourceUrl: "https://example.com/source",
            name: "legacy-after-upgrade",
            description: "description",
            categories: [],
            tags: [],
            requiresApiKey: false,
            risk: "safe",
            version: "1.0.0",
            updatedAt: "2026-07-17T00:00:00.000Z",
            downloads: 1,
            favorites: 1,
            score: 1,
            featured: false,
            enterprise: false,
            delisted: false,
          },
          detailKey: "details/legacy-after-upgrade.json",
          detailSha256: "b".repeat(64),
        },
      ]),
    ).toBe(1)
    expect(
      upgraded.connection
        .query<{ generation_id: string }, [string]>(
          "SELECT generation_id FROM skillhub_import_items WHERE slug = ?",
        )
        .get("legacy-after-upgrade"),
    ).toEqual({ generation_id: "other-active" })
    expect(
      upgraded.connection
        .query<{ last_published_count: number }, [string]>(
          "SELECT last_published_count FROM skillhub_generations WHERE id = ?",
        )
        .get("draining"),
    ).toEqual({ last_published_count: 2 })
    expect(upgraded.connection.query<{ foreign_key_check: string }, []>("PRAGMA foreign_key_check").all()).toEqual([])
    expect(upgraded.connection.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
    upgraded.close()
  })
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-"))
  directories.push(directory)
  return directory
}
