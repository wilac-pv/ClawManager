import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"

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
    expect(database.connection.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2)
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
    ).toEqual([2, 2])
    databases.forEach((database) => database.close())
  })
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-"))
  directories.push(directory)
  return directory
}
