import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { createFavorites } from "../src/favorites"
import { type Principal, SkillMarketSecurityError } from "../src/security"
import type { Connection } from "../src/store"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("favorites", () => {
  test("stores idempotent per-user favorites and removes them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skill-market-favorites-"))
    directories.push(directory)
    const database = await openDatabase({
      databasePath: join(directory, "market.db"),
      migrationBackupDirectory: join(directory, "backups"),
    })
    await database.transaction(async (c) =>
      c.run(
        "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
        ["E000001", "User One", 1, 1, "E000002", "User Two", 1, 1],
      ),
    )
    const favorites = createFavorites({
      database,
      now: () => Date.parse("2026-07-24T00:00:00.000Z"),
    })

    await favorites.add(principal("E000001"), { source: "skillhub", id: "code-review" })
    await favorites.add(principal("E000001"), { source: "skillhub", id: "code-review" })
    await favorites.add(principal("E000002"), { source: "enterprise", id: "internal-docs" })
    expect(await favorites.list(principal("E000001"))).toEqual([
      {
        source: "skillhub",
        id: "code-review",
        createdAt: "2026-07-24T00:00:00.000Z",
      },
    ])

    await favorites.remove(principal("E000001"), { source: "skillhub", id: "code-review" })
    expect(await favorites.list(principal("E000001"))).toEqual([])
    expect(await favorites.list(principal("E000002"))).toHaveLength(1)
    await database.close()
  })

  test("enforces current restricted publication access when adding and listing favorites", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skill-market-restricted-favorites-"))
    directories.push(directory)
    const database = await openDatabase({
      databasePath: join(directory, "market.db"),
      migrationBackupDirectory: join(directory, "backups"),
    })
    await database.transaction(async (connection) => {
      await connection.run(
        `INSERT INTO departments (department_id, display_name, first_seen_at, last_seen_at)
         VALUES ('engineering', 'Engineering', 1, 1), ('other', 'Other', 1, 1)`,
      )
      for (const [employeeID, departmentID] of [
        ["owner", "engineering"],
        ["department", "engineering"],
        ["group", "other"],
        ["outsider", "other"],
      ] as const)
        await connection.run(
          "INSERT INTO users (employee_id, display_name, department_id, created_at, last_login_at) VALUES (?, ?, ?, 1, 1)",
          [employeeID, employeeID, departmentID],
        )
      await connection.run(
        `INSERT INTO market_groups (id, name, owner_employee_id, status, version, created_at, updated_at)
         VALUES ('grp_favorites1', 'Favorites', 'owner', 'active', 1, 1, 1)`,
      )
      await connection.run(
        `INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at)
         VALUES ('grp_favorites1', 'group', 'owner', 1)`,
      )
      await seedRestrictedFavorite(connection, {
        publicationID: "pub_favdepart01",
        submissionID: "sub_favdepart01",
        skillID: "favorite-department",
        scope: "department",
        departmentID: "engineering",
      })
      await seedRestrictedFavorite(connection, {
        publicationID: "pub_favgroup001",
        submissionID: "sub_favgroup001",
        skillID: "favorite-group",
        scope: "groups",
        groupID: "grp_favorites1",
      })
    })
    const favorites = createFavorites({ database, now: () => Date.parse("2026-07-24T00:00:00.000Z") })

    await expect(
      favorites.add(principal("outsider"), { source: "restricted", id: "pub_favgroup001" }),
    ).rejects.toBeInstanceOf(SkillMarketSecurityError)
    await favorites.add(principal("department"), { source: "restricted", id: "pub_favdepart01" })
    await favorites.add(principal("group"), { source: "restricted", id: "pub_favgroup001" })
    expect((await favorites.list(principal("department"))).map((favorite) => favorite.id)).toEqual(["pub_favdepart01"])
    expect((await favorites.list(principal("group"))).map((favorite) => favorite.id)).toEqual(["pub_favgroup001"])

    await database.transaction(async (c) =>
      c.run("DELETE FROM market_group_members WHERE group_id = 'grp_favorites1' AND employee_id = 'group'"),
    )
    expect(await favorites.list(principal("group"))).toEqual([])
    await database.transaction(async (c) =>
      c.run(
        "INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at) VALUES ('grp_favorites1', 'group', 'owner', 2)",
      ),
    )
    await database.transaction(async (c) =>
      c.run("UPDATE market_groups SET status = 'disabled' WHERE id = 'grp_favorites1'"),
    )
    expect(await favorites.list(principal("group"))).toEqual([])
    await database.transaction(async (c) =>
      c.run("UPDATE users SET department_id = 'other' WHERE employee_id = 'department'"),
    )
    expect(await favorites.list(principal("department"))).toEqual([])
    await database.transaction(async (c) =>
      c.run("UPDATE market_groups SET status = 'active' WHERE id = 'grp_favorites1'"),
    )
    await database.transaction(async (c) =>
      c.run("UPDATE restricted_publications SET status = 'delisted' WHERE id = 'pub_favgroup001'"),
    )
    expect(await favorites.list(principal("group"))).toEqual([])
    await database.close()
  })
})

async function seedRestrictedFavorite(
  connection: Connection,
  input: {
    readonly publicationID: string
    readonly submissionID: string
    readonly skillID: string
    readonly scope: "groups" | "department"
    readonly departmentID?: string
    readonly groupID?: string
  },
) {
  await connection.run(
    `INSERT INTO submissions
      (id, skill_id, owner_employee_id, target_version, status, current_revision, version, created_at, updated_at,
       target_scope, target_department_id)
     VALUES (?, ?, 'owner', '1.0.0', 'published', 1, 1, 1, 1, ?, ?)`,
    [input.submissionID, input.skillID, input.scope, input.departmentID ?? null],
  )
  await connection.run(
    `INSERT INTO restricted_publications
      (id, submission_id, skill_id, owner_employee_id, version, scope, department_id, package_key,
       package_sha256, package_size, metadata_json, status, row_version, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', '1.0.0', ?, ?, ?, ?, 1, '{}', 'published', 1, 1, 1)`,
    [
      input.publicationID,
      input.submissionID,
      input.skillID,
      input.scope,
      input.departmentID ?? null,
      `private/${input.publicationID}/package.zip`,
      "a".repeat(64),
    ],
  )
  if (input.groupID)
    await connection.run("INSERT INTO restricted_publication_groups (publication_id, group_id) VALUES (?, ?)", [
      input.publicationID,
      input.groupID,
    ])
}

function principal(employeeID: string): Principal {
  return {
    csrfHash: "",
    session: {
      user: { employeeID, displayName: employeeID },
      roles: [],
      csrfToken: "_".repeat(43),
      createdAt: "2026-07-24T00:00:00.000Z",
      absoluteExpiresAt: "2026-07-24T12:00:00.000Z",
      idleExpiresAt: "2026-07-24T02:00:00.000Z",
    },
  }
}
