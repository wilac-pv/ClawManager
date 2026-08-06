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
    const group = await fixture.groups.create(fixture.alice, {
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
    expect(await fixture.groups.listMine(fixture.alice)).toEqual({ managed: [group], joined: [] })
    expect(await fixture.groups.listMine(fixture.bob)).toEqual({ managed: [], joined: [] })
    expect(await fixture.groups.members(fixture.alice, group.id)).toEqual([
      {
        groupID: group.id,
        employeeID: "alice",
        createdByEmployeeID: "alice",
        createdAt: "2026-08-04T00:00:00.000Z",
      },
    ])

    await fixture.groups.addMember(fixture.alice, group.id, { employeeID: "future-user", expectedVersion: 1 })
    await fixture.groups.addMember(fixture.alice, group.id, { employeeID: "bob", expectedVersion: 2 })
    expect(
      await fixture.database.read(async (c) =>
        c.get<{ employee_id: string }>(
          "SELECT employee_id FROM market_group_members WHERE group_id = ? AND employee_id = ?",
          [group.id, "future-user"],
        ),
      ),
    ).toEqual({ employee_id: "future-user" })
    expect(
      (
        await fixture.database.read(async (c) =>
          c.get<{ count: number }>("SELECT count(*) AS count FROM users WHERE employee_id = ?", ["future-user"]),
        )
      )?.count,
    ).toBe(0)
    expect(await fixture.groups.listMine(principal("future-user"))).toMatchObject({
      managed: [],
      joined: [{ id: group.id, version: 3 }],
    })
    expect(await fixture.groups.listMine(fixture.bob)).toMatchObject({
      managed: [],
      joined: [{ id: group.id, version: 3 }],
    })
    await expect(
      fixture.groups.update(fixture.bob, group.id, { expectedVersion: 3, name: "Member cannot rename" }),
    ).rejects.toThrow("forbidden")
    expect(await fixture.groups.get(principal("future-user"), group.id)).toMatchObject({ id: group.id, version: 3 })
    await expect(fixture.groups.get(principal("outsider"), group.id)).rejects.toThrow("not found")

    await fixture.database.close()
  })

  test("enforces owner or admin mutations, optimistic versions, transfer invariants, and audit history", async () => {
    const fixture = await groupsFixture()
    const created = await fixture.groups.create(fixture.alice, { name: "Project Aurora", description: "专项组" })

    await expect(
      fixture.groups.addMember(fixture.bob, created.id, {
        employeeID: "future-user",
        expectedVersion: created.version,
      }),
    ).rejects.toThrow("forbidden")

    const added = await fixture.groups.addMember(fixture.alice, created.id, {
      employeeID: "future-user",
      expectedVersion: created.version,
    })
    expect(added).toMatchObject({ groupID: created.id, employeeID: "future-user", createdByEmployeeID: "alice" })
    await expect(
      fixture.groups.update(fixture.alice, created.id, { expectedVersion: created.version, name: "Stale" }),
    ).rejects.toThrow("version conflict")

    const updated = await fixture.groups.update(fixture.alice, created.id, {
      expectedVersion: 2,
      name: "Aurora Team",
      description: null,
    })
    expect(updated).toMatchObject({ name: "Aurora Team", version: 3 })
    expect(updated).not.toHaveProperty("description")

    const transferred = await fixture.groups.transfer(fixture.admin, created.id, {
      expectedVersion: 3,
      ownerEmployeeID: "future-owner",
    })
    expect(transferred).toMatchObject({ ownerEmployeeID: "future-owner", version: 4 })
    expect((await fixture.groups.members(fixture.admin, created.id)).map((member) => member.employeeID)).toEqual([
      "alice",
      "future-owner",
      "future-user",
    ])
    await expect(
      fixture.groups.removeMember(principal("future-owner"), created.id, "future-owner", { expectedVersion: 4 }),
    ).rejects.toThrow("current owner")

    const removed = await fixture.groups.removeMember(fixture.admin, created.id, "alice", { expectedVersion: 4 })
    expect(removed.version).toBe(5)
    const disabled = await fixture.groups.setStatus(fixture.admin, created.id, {
      expectedVersion: 5,
      status: "disabled",
    })
    expect(disabled).toMatchObject({ status: "disabled", version: 6 })
    await fixture.database.transaction(async (c) =>
      c.run(
        "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
        ["future-owner", "Future Owner", now, now],
      ),
    )
    const restored = await fixture.groups.setStatus(principal("future-owner"), created.id, {
      expectedVersion: 6,
      status: "active",
    })
    expect(restored).toMatchObject({ status: "active", version: 7 })

    const audit = await fixture.database.read(async (c) =>
      c.all<{ action: SkillMarketControl.AuditAction; object_type: SkillMarketControl.AuditObjectType }>(
        "SELECT action, object_type FROM audit_events WHERE object_id = ? ORDER BY rowid",
        [created.id],
      ),
    )
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
    const page = await createModeration({
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

    await fixture.database.close()
  })

  test("lists every group once in the admin managed section", async () => {
    const fixture = await groupsFixture()
    const created = await fixture.groups.create(fixture.alice, { name: "Project Aurora" })
    await fixture.groups.addMember(fixture.alice, created.id, { employeeID: "admin", expectedVersion: 1 })

    expect(await fixture.groups.listMine(fixture.admin)).toMatchObject({
      managed: [{ id: created.id, version: 2 }],
      joined: [],
    })

    await fixture.database.close()
  })
})

async function groupsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "skill-market-groups-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  await database.transaction(async (c) => {
    await c.run(
      `INSERT INTO users (employee_id, display_name, created_at, last_login_at)
       VALUES ('alice', 'Alice', ?, ?), ('bob', 'Bob', ?, ?), ('admin', 'Admin', ?, ?)`,
      [now, now, now, now, now, now],
    )
    await c.run(
      `INSERT INTO departments (department_id, display_name, first_seen_at, last_seen_at)
       VALUES ('engineering', 'Engineering', ?, ?), ('design', 'Design', ?, ?)`,
      [now, now, now, now],
    )
    await c.run(
      "UPDATE users SET department_id = CASE employee_id WHEN 'alice' THEN 'engineering' WHEN 'bob' THEN 'design' END WHERE employee_id IN ('alice', 'bob')",
    )
  })
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
