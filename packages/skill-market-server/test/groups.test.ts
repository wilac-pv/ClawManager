import { afterEach, describe, expect, test } from "bun:test"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { createGroups } from "../src/groups"
import { createModeration } from "../src/moderation"
import { createSecurity, type Principal } from "../src/security"

const directories: string[] = []
const now = Date.parse("2026-08-04T00:00:00.000Z")

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("sharing groups", () => {
  test("persists owners and pending cross-department members without requiring a user row", async () => {
    const fixture = await groupsFixture()
    const group = fixture.groups.create(fixture.alice, {
      name: "Project Aurora",
      description: "跨部门专项组",
    })

    expect(Schema.is(SkillMarketControl.GroupID)(group.id)).toBeTrue()
    expect(group).toMatchObject({
      name: "Project Aurora",
      description: "跨部门专项组",
      ownerEmployeeID: "alice",
      status: "active",
      version: 1,
    })
    expect(fixture.groups.listMine(fixture.alice)).toEqual({ managed: [group], joined: [] })
    expect(fixture.groups.listMine(fixture.bob)).toEqual({ managed: [], joined: [] })
    expect(fixture.groups.members(fixture.alice, group.id)).toEqual([
      {
        groupID: group.id,
        employeeID: "alice",
        createdByEmployeeID: "alice",
        createdAt: "2026-08-04T00:00:00.000Z",
      },
    ])

    fixture.groups.addMember(fixture.alice, group.id, { employeeID: "future-user", expectedVersion: 1 })
    fixture.groups.addMember(fixture.alice, group.id, { employeeID: "bob", expectedVersion: 2 })
    expect(
      fixture.database.connection
        .query<
          { employee_id: string },
          [string, string]
        >("SELECT employee_id FROM market_group_members WHERE group_id = ? AND employee_id = ?")
        .get(group.id, "future-user"),
    ).toEqual({ employee_id: "future-user" })
    expect(
      fixture.database.connection
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM users WHERE employee_id = ?")
        .get("future-user")?.count,
    ).toBe(0)
    expect(fixture.groups.listMine(principal("future-user"))).toMatchObject({
      managed: [],
      joined: [{ id: group.id, version: 3 }],
    })
    expect(fixture.groups.listMine(fixture.bob)).toMatchObject({
      managed: [],
      joined: [{ id: group.id, version: 3 }],
    })
    expect(() =>
      fixture.groups.update(fixture.bob, group.id, { expectedVersion: 3, name: "Member cannot rename" }),
    ).toThrow("forbidden")
    expect(fixture.groups.get(principal("future-user"), group.id)).toMatchObject({ id: group.id, version: 3 })
    expect(() => fixture.groups.get(principal("outsider"), group.id)).toThrow("not found")

    fixture.database.close()
  })

  test("enforces owner or admin mutations, optimistic versions, transfer invariants, and audit history", async () => {
    const fixture = await groupsFixture()
    const created = fixture.groups.create(fixture.alice, { name: "Project Aurora", description: "专项组" })

    expect(() =>
      fixture.groups.addMember(fixture.bob, created.id, {
        employeeID: "future-user",
        expectedVersion: created.version,
      }),
    ).toThrow("forbidden")

    const added = fixture.groups.addMember(fixture.alice, created.id, {
      employeeID: "future-user",
      expectedVersion: created.version,
    })
    expect(added).toMatchObject({ groupID: created.id, employeeID: "future-user", createdByEmployeeID: "alice" })
    expect(() =>
      fixture.groups.update(fixture.alice, created.id, { expectedVersion: created.version, name: "Stale" }),
    ).toThrow("version conflict")

    const updated = fixture.groups.update(fixture.alice, created.id, {
      expectedVersion: 2,
      name: "Aurora Team",
      description: null,
    })
    expect(updated).toMatchObject({ name: "Aurora Team", version: 3 })
    expect(updated).not.toHaveProperty("description")

    const transferred = fixture.groups.transfer(fixture.admin, created.id, {
      expectedVersion: 3,
      ownerEmployeeID: "future-owner",
    })
    expect(transferred).toMatchObject({ ownerEmployeeID: "future-owner", version: 4 })
    expect(fixture.groups.members(fixture.admin, created.id).map((member) => member.employeeID)).toEqual([
      "alice",
      "future-owner",
      "future-user",
    ])
    expect(() =>
      fixture.groups.removeMember(principal("future-owner"), created.id, "future-owner", { expectedVersion: 4 }),
    ).toThrow("current owner")

    const removed = fixture.groups.removeMember(fixture.admin, created.id, "alice", { expectedVersion: 4 })
    expect(removed.version).toBe(5)
    const disabled = fixture.groups.setStatus(fixture.admin, created.id, { expectedVersion: 5, status: "disabled" })
    expect(disabled).toMatchObject({ status: "disabled", version: 6 })
    fixture.database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
      ["future-owner", "Future Owner", now, now],
    )
    const restored = fixture.groups.setStatus(principal("future-owner"), created.id, {
      expectedVersion: 6,
      status: "active",
    })
    expect(restored).toMatchObject({ status: "active", version: 7 })

    const audit = fixture.database.connection
      .query<
        { action: SkillMarketControl.AuditAction; object_type: SkillMarketControl.AuditObjectType },
        [string]
      >("SELECT action, object_type FROM audit_events WHERE object_id = ? ORDER BY rowid")
      .all(created.id)
    expect(audit).toEqual([
      { action: "group-created", object_type: "group" },
      { action: "group-member-added", object_type: "group" },
      { action: "group-updated", object_type: "group" },
      { action: "group-ownership-transferred", object_type: "group" },
      { action: "group-member-removed", object_type: "group" },
      { action: "group-disabled", object_type: "group" },
      { action: "group-restored", object_type: "group" },
    ])
    expect(audit.every((event) => Schema.is(SkillMarketControl.AuditAction)(event.action))).toBeTrue()
    expect(audit.every((event) => Schema.is(SkillMarketControl.AuditObjectType)(event.object_type))).toBeTrue()
    const page = createModeration({
      database: fixture.database,
      security: createSecurity({
        database: fixture.database,
        webOrigin: "https://market.example.com",
        sessionIdleMilliseconds: 1,
        sessionAbsoluteMilliseconds: 1,
      }),
      now: () => now,
    }).listAudit(fixture.admin, { page: 1, limit: 30 })
    expect(page.items.filter((event) => event.objectID === created.id).map((event) => event.action)).toEqual(
      audit.map((event) => event.action).toReversed(),
    )

    fixture.database.close()
  })

  test("lists every group once in the admin managed section", async () => {
    const fixture = await groupsFixture()
    const created = fixture.groups.create(fixture.alice, { name: "Project Aurora" })
    fixture.groups.addMember(fixture.alice, created.id, { employeeID: "admin", expectedVersion: 1 })

    expect(fixture.groups.listMine(fixture.admin)).toMatchObject({
      managed: [{ id: created.id, version: 2 }],
      joined: [],
    })

    fixture.database.close()
  })
})

async function groupsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "skill-market-groups-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  database.connection.run(
    `INSERT INTO users (employee_id, display_name, created_at, last_login_at)
     VALUES ('alice', 'Alice', ?, ?), ('bob', 'Bob', ?, ?), ('admin', 'Admin', ?, ?)`,
    [now, now, now, now, now, now],
  )
  database.connection.run(
    `INSERT INTO departments (department_id, display_name, first_seen_at, last_seen_at)
     VALUES ('engineering', 'Engineering', ?, ?), ('design', 'Design', ?, ?)`,
    [now, now, now, now],
  )
  database.connection.run(
    "UPDATE users SET department_id = CASE employee_id WHEN 'alice' THEN 'engineering' WHEN 'bob' THEN 'design' END WHERE employee_id IN ('alice', 'bob')",
  )
  return {
    database,
    groups: createGroups({ database, now: () => now }),
    alice: principal("alice"),
    bob: principal("bob"),
    admin: principal("admin", ["admin"]),
  }
}

function principal(employeeID: string, roles: ReadonlyArray<SkillMarketControl.Role> = []): Principal {
  return {
    csrfHash: "",
    session: {
      user: { employeeID, displayName: employeeID },
      roles,
      csrfToken: "_".repeat(43),
      createdAt: "2026-08-04T00:00:00.000Z",
      absoluteExpiresAt: "2026-08-04T12:00:00.000Z",
      idleExpiresAt: "2026-08-04T02:00:00.000Z",
    },
  }
}
