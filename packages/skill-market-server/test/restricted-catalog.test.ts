import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInstallGrants } from "../src/install-grants"
import { createRestrictedCatalog } from "../src/restricted-catalog"
import { openDatabase } from "../src/database"
import { hashSecret, type Principal, SkillMarketSecurityError } from "../src/security"

const directories: string[] = []
const initialNow = Date.parse("2026-08-05T00:00:00.000Z")

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("restricted catalog", () => {
  test("uses one current authorization policy for summaries, detail, and versions", async () => {
    const fixture = await restrictedFixture()
    try {
      expect((await fixture.catalog.list(fixture.principals.owner)).map((item) => item.id)).toEqual([
        "pub_department1",
        "pub_disabledgrp",
        "pub_groupmember",
      ])
      expect((await fixture.catalog.list(fixture.principals.admin)).map((item) => item.id)).toEqual([
        "pub_department1",
        "pub_disabledgrp",
        "pub_groupmember",
      ])
      expect((await fixture.catalog.list(fixture.principals.department)).map((item) => item.id)).toEqual([
        "pub_department1",
      ])
      expect((await fixture.catalog.list(fixture.principals.group)).map((item) => item.id)).toEqual([
        "pub_groupmember",
      ])
      expect(await fixture.catalog.detail(fixture.principals.group, "pub_groupmember")).toMatchObject({
        id: "pub_groupmember",
        visibility: "groups",
        version: "2.0.0",
      })
      expect(await fixture.catalog.versions(fixture.principals.group, "pub_groupmember")).toEqual([
        expect.objectContaining({ version: "2.0.0" }),
      ])
      expect(() => fixture.catalog.require(fixture.principals.outsider, "pub_groupmember")).toThrow(
        SkillMarketSecurityError,
      )
      expect(() => fixture.catalog.require(fixture.principals.group, "pub_disabledgrp")).toThrow(
        SkillMarketSecurityError,
      )
      expect(() => fixture.catalog.require(fixture.principals.owner, "pub_delisted001")).toThrow(
        SkillMarketSecurityError,
      )
      expect(() => fixture.catalog.require(fixture.principals.owner, "pub_missing0001")).toThrow(
        SkillMarketSecurityError,
      )

      fixture.database.connection.run(
        "DELETE FROM market_group_members WHERE group_id = 'grp_active0001' AND employee_id = 'group'",
      )
      fixture.database.connection.run("UPDATE users SET department_id = 'other' WHERE employee_id = 'department'")
      expect(await fixture.catalog.list(fixture.principals.group)).toEqual([])
      expect(await fixture.catalog.list(fixture.principals.department)).toEqual([])
    } finally {
      fixture.database.close()
    }
  })

  test("issues only hashed exact ten-minute grants and rechecks access until expiry", async () => {
    const fixture = await restrictedFixture()
    try {
      const grant = fixture.grants.issue(fixture.principals.group, "pub_groupmember")
      const url = new URL(grant.url)
      const token = url.pathname.split("/").at(-1)!
      expect(url.origin).toBe("https://market.example")
      expect(grant.expiresAt).toBe(new Date(initialNow + 10 * 60_000).toISOString())
      expect(token).toHaveLength(43)
      const stored = fixture.database.connection
        .query<
          { token_hash: string; employee_id: string; publication_id: string; expires_at: number; created_at: number },
          []
        >("SELECT token_hash, employee_id, publication_id, expires_at, created_at FROM private_install_grants")
        .get()!
      expect(stored).toEqual({
        token_hash: hashSecret(token),
        employee_id: "group",
        publication_id: "pub_groupmember",
        expires_at: initialNow + 10 * 60_000,
        created_at: initialNow,
      })
      expect(JSON.stringify(stored)).not.toContain(token)
      expect(fixture.grants.resolve(token)).toMatchObject({
        publicationID: "pub_groupmember",
        employeeID: "group",
        key: "skill-market-private/group.zip",
      })
      expect(fixture.grants.resolve("malformed")).toBeUndefined()

      fixture.database.connection.run(
        "DELETE FROM market_group_members WHERE group_id = 'grp_active0001' AND employee_id = 'group'",
      )
      expect(fixture.grants.resolve(token)).toBeUndefined()
      fixture.database.connection.run(
        "INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at) VALUES (?, ?, ?, ?)",
        ["grp_active0001", "group", "owner", initialNow],
      )
      fixture.clock.value = initialNow + 10 * 60_000
      expect(fixture.grants.resolve(token)).toBeUndefined()
    } finally {
      fixture.database.close()
    }
  })
})

async function restrictedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-restricted-catalog-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const clock = { value: initialNow }
  database.transaction((connection) => {
    connection.run(
      "INSERT INTO departments (department_id, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
      ["engineering", "Engineering", initialNow, initialNow, "other", "Other", initialNow, initialNow],
    )
    ;[
      ["owner", "Owner", "engineering"],
      ["admin", "Admin", "other"],
      ["department", "Department", "engineering"],
      ["group", "Group", "other"],
      ["outsider", "Outsider", "other"],
    ].forEach((user) =>
      connection.run(
        "INSERT INTO users (employee_id, display_name, department_id, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
        [user[0], user[1], user[2], initialNow, initialNow],
      ),
    )
    connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES ('admin', 'admin', 'admin', ?)",
      [initialNow],
    )
    connection.run(
      `INSERT INTO market_groups (id, name, owner_employee_id, status, version, created_at, updated_at)
       VALUES ('grp_active0001', 'Active', 'owner', 'active', 1, ?, ?),
              ('grp_disabled01', 'Disabled', 'owner', 'disabled', 1, ?, ?)`,
      [initialNow, initialNow, initialNow, initialNow],
    )
    connection.run(
      `INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at)
       VALUES ('grp_active0001', 'group', 'owner', ?), ('grp_disabled01', 'group', 'owner', ?)`,
      [initialNow, initialNow],
    )
    seedPublication(connection, {
      id: "pub_department1",
      submissionID: "sub_department1",
      skillID: "department-skill",
      version: "1.0.0",
      scope: "department",
      departmentID: "engineering",
      key: "skill-market-private/department.zip",
    })
    seedPublication(connection, {
      id: "pub_groupmember",
      submissionID: "sub_groupmember",
      skillID: "group-skill",
      version: "2.0.0",
      scope: "groups",
      groupID: "grp_active0001",
      key: "skill-market-private/group.zip",
    })
    seedPublication(connection, {
      id: "pub_disabledgrp",
      submissionID: "sub_disabledgrp",
      skillID: "disabled-skill",
      version: "3.0.0",
      scope: "groups",
      groupID: "grp_disabled01",
      key: "skill-market-private/disabled.zip",
    })
    seedPublication(connection, {
      id: "pub_delisted001",
      submissionID: "sub_delisted001",
      skillID: "delisted-skill",
      version: "4.0.0",
      scope: "groups",
      groupID: "grp_active0001",
      key: "skill-market-private/delisted.zip",
      status: "delisted",
    })
  })
  const catalog = createRestrictedCatalog({ database, apiPublicUrl: "https://market.example", now: () => clock.value })
  return {
    database,
    clock,
    catalog,
    grants: createInstallGrants({
      database,
      restrictedCatalog: catalog,
      apiPublicUrl: "https://market.example",
      now: () => clock.value,
    }),
    principals: {
      owner: principal("owner"),
      admin: principal("admin", ["admin"]),
      department: principal("department"),
      group: principal("group"),
      outsider: principal("outsider"),
    },
  }
}

function seedPublication(
  connection: import("bun:sqlite").Database,
  input: {
    readonly id: string
    readonly submissionID: string
    readonly skillID: string
    readonly version: string
    readonly scope: "groups" | "department"
    readonly departmentID?: string
    readonly groupID?: string
    readonly key: string
    readonly status?: "published" | "delisted"
  },
) {
  const metadata = {
    version: input.version,
    displayName: input.skillID,
    description: `${input.skillID} description`,
    category: "Developer Tools",
    tags: ["restricted"],
    requiresApiKey: false,
    changeNotes: "Published",
  }
  const sha256 = new Bun.CryptoHasher("sha256").update(input.id).digest("hex")
  connection.run(
    `INSERT INTO submissions
      (id, skill_id, owner_employee_id, target_version, target_scope, target_department_id,
       status, current_revision, version, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?, 'published', 1, 1, ?, ?)`,
    [input.submissionID, input.skillID, input.version, input.scope, input.departmentID ?? null, initialNow, initialNow],
  )
  connection.run(
    `INSERT INTO submission_revisions
      (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json,
       manifest_json, scan_json, validation_errors_json, created_at)
     VALUES (?, 1, ?, ?, 128, ?, ?, ?, '[]', ?)`,
    [
      input.submissionID,
      input.key,
      sha256,
      JSON.stringify(metadata),
      JSON.stringify({ packageSha256: sha256, packageSize: 128, files: [] }),
      JSON.stringify({ risk: "safe", reasons: [], evidence: [], scannedAt: new Date(initialNow).toISOString() }),
      initialNow,
    ],
  )
  connection.run(
    `INSERT INTO restricted_publications
      (id, submission_id, skill_id, owner_employee_id, version, scope, department_id, package_key,
       package_sha256, package_size, metadata_json, status, row_version, created_at, updated_at)
     VALUES (?, ?, ?, 'owner', ?, ?, ?, ?, ?, 128, ?, ?, 1, ?, ?)`,
    [
      input.id,
      input.submissionID,
      input.skillID,
      input.version,
      input.scope,
      input.departmentID ?? null,
      input.key,
      sha256,
      JSON.stringify(metadata),
      input.status ?? "published",
      initialNow,
      initialNow,
    ],
  )
  if (input.groupID)
    connection.run("INSERT INTO restricted_publication_groups (publication_id, group_id) VALUES (?, ?)", [
      input.id,
      input.groupID,
    ])
}

function principal(employeeID: string, roles: Principal["session"]["roles"] = []): Principal {
  return {
    session: {
      user: { employeeID, displayName: employeeID },
      roles,
      csrfToken: "_".repeat(43),
      createdAt: new Date(initialNow).toISOString(),
      absoluteExpiresAt: new Date(initialNow + 1_000_000).toISOString(),
      idleExpiresAt: new Date(initialNow + 1_000_000).toISOString(),
    },
    csrfHash: "",
  }
}
