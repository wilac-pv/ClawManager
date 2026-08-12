import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Option, Schema } from "effect"
import type { Connection, MarketDatabase } from "./store"
import { randomSecret, type Principal, SkillMarketSecurityError } from "./security"

interface GroupRow {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly owner_employee_id: string
  readonly status: SkillMarketControl.MarketGroup["status"]
  readonly version: number
  readonly created_at: number
  readonly updated_at: number
}

interface MemberRow {
  readonly group_id: string
  readonly employee_id: string
  readonly added_by_employee_id: string
  readonly created_at: number
}

interface GroupsOptions {
  readonly database: MarketDatabase
  readonly now?: () => number
}

export function createGroups(options: GroupsOptions) {
  return {
    create(principal: Principal, input: SkillMarketControl.GroupCreateInput) {
      const decoded = Schema.decodeUnknownOption(SkillMarketControl.GroupCreateInput)(input)
      if (Option.isNone(decoded)) throw invalid("group creation is invalid")
      const id = `grp_${randomSecret()}`
      const now = options.now?.() ?? Date.now()
      return options.database.transaction(async (connection) => {
        const owned = await connection.get<{ count: number }>(
          "SELECT count(*) AS count FROM market_groups WHERE owner_employee_id = ? AND status = 'active'",
          [principal.session.user.employeeID],
        )
        if (owned && owned.count >= 5)
          throw new SkillMarketSecurityError("invalid-request", "每人最多创建 5 个活跃小组")
        await connection.run(
          `INSERT INTO market_groups
            (id, name, description, owner_employee_id, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
          [id, decoded.value.name, decoded.value.description ?? null, principal.session.user.employeeID, now, now],
        )
        await connection.run(
          `INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at)
           VALUES (?, ?, ?, ?)`,
          [id, principal.session.user.employeeID, principal.session.user.employeeID, now],
        )
        await insertAudit(connection, {
          actorEmployeeID: principal.session.user.employeeID,
          action: "group-created",
          objectID: id,
          after: {
            name: decoded.value.name,
            ...(decoded.value.description ? { description: decoded.value.description } : {}),
            ownerEmployeeID: principal.session.user.employeeID,
            status: "active",
            version: 1,
          },
          now,
        })
        return group(await requireGroup(connection, id))
      })
    },

    listMine(principal: Principal) {
      return options.database.read(async (connection) => {
        const employeeID = principal.session.user.employeeID
        const admin = principal.session.roles.includes("admin")
        const managed = (
          await connection.all<GroupRow>(
            `${groupSelect()}
             WHERE ? = 1 OR market_groups.owner_employee_id = ?
             ORDER BY market_groups.updated_at DESC, market_groups.id`,
            [admin ? 1 : 0, employeeID],
          )
        ).map(group)
        const joined = admin
          ? []
          : (
              await connection.all<GroupRow>(
                `${groupSelect()}
                 INNER JOIN market_group_members ON market_group_members.group_id = market_groups.id
                 WHERE market_group_members.employee_id = ?
                   AND market_groups.owner_employee_id != market_group_members.employee_id
                 ORDER BY market_groups.updated_at DESC, market_groups.id`,
                [employeeID],
              )
            ).map(group)
        return Schema.decodeUnknownSync(SkillMarketControl.GroupPage)({ managed, joined })
      })
    },

    get(principal: Principal, groupID: string) {
      requireGroupID(groupID)
      return options.database.read(async (connection) => group(await requireVisibleGroup(connection, principal, groupID)))
    },

    update(principal: Principal, groupID: string, input: SkillMarketControl.GroupUpdateInput) {
      requireGroupID(groupID)
      const decoded = Schema.decodeUnknownOption(SkillMarketControl.GroupUpdateInput)(input)
      if (Option.isNone(decoded)) throw invalid("group update is invalid")
      const now = options.now?.() ?? Date.now()
      return options.database.transaction(async (connection) => {
        const current = await requireMutableGroup(connection, principal, groupID, decoded.value.expectedVersion)
        const nextName = decoded.value.name ?? current.name
        const nextDescription =
          decoded.value.description === undefined ? current.description : decoded.value.description
        await connection.run(
          `UPDATE market_groups
           SET name = ?, description = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
          [nextName, nextDescription, now, groupID],
        )
        await insertAudit(connection, {
          actorEmployeeID: principal.session.user.employeeID,
          action: "group-updated",
          objectID: groupID,
          before: { name: current.name, description: current.description, version: current.version },
          after: { name: nextName, description: nextDescription, version: current.version + 1 },
          now,
        })
        return group(await requireGroup(connection, groupID))
      })
    },

    transfer(principal: Principal, groupID: string, input: SkillMarketControl.GroupOwnerInput) {
      requireGroupID(groupID)
      const decoded = Schema.decodeUnknownOption(SkillMarketControl.GroupOwnerInput)(input)
      if (Option.isNone(decoded)) throw invalid("group ownership transfer is invalid")
      const now = options.now?.() ?? Date.now()
      return options.database.transaction(async (connection) => {
        const current = await requireMutableGroup(connection, principal, groupID, decoded.value.expectedVersion)
        if (current.owner_employee_id === decoded.value.ownerEmployeeID)
          throw invalid("group owner is already assigned")
        const existing = (
          await connection.get<{ count: number }>(
            "SELECT count(*) AS count FROM market_group_members WHERE group_id = ? AND employee_id = ?",
            [groupID, decoded.value.ownerEmployeeID],
          )
        )?.count ?? 0
        if (existing === 0)
          await connection.run(
            `INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at)
             VALUES (?, ?, ?, ?)`,
            [groupID, decoded.value.ownerEmployeeID, principal.session.user.employeeID, now],
          )
        await connection.run(
          `UPDATE market_groups
           SET owner_employee_id = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
          [decoded.value.ownerEmployeeID, now, groupID],
        )
        await insertAudit(connection, {
          actorEmployeeID: principal.session.user.employeeID,
          action: "group-ownership-transferred",
          objectID: groupID,
          before: { ownerEmployeeID: current.owner_employee_id, version: current.version },
          after: {
            ownerEmployeeID: decoded.value.ownerEmployeeID,
            version: current.version + 1,
            memberAdded: existing === 0,
          },
          now,
        })
        return group(await requireGroup(connection, groupID))
      })
    },

    setStatus(principal: Principal, groupID: string, input: SkillMarketControl.GroupStatusInput) {
      requireGroupID(groupID)
      const decoded = Schema.decodeUnknownOption(SkillMarketControl.GroupStatusInput)(input)
      if (Option.isNone(decoded)) throw invalid("group status update is invalid")
      const now = options.now?.() ?? Date.now()
      return options.database.transaction(async (connection) => {
        const current = await requireMutableGroup(connection, principal, groupID, decoded.value.expectedVersion)
        if (current.status === decoded.value.status) throw invalid("group already has the requested status")
        await connection.run(
          `UPDATE market_groups
           SET status = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
          [decoded.value.status, now, groupID],
        )
        await insertAudit(connection, {
          actorEmployeeID: principal.session.user.employeeID,
          action: decoded.value.status === "disabled" ? "group-disabled" : "group-restored",
          objectID: groupID,
          before: { status: current.status, version: current.version },
          after: { status: decoded.value.status, version: current.version + 1 },
          now,
        })
        return group(await requireGroup(connection, groupID))
      })
    },

    members(principal: Principal, groupID: string) {
      requireGroupID(groupID)
      return options.database.read(async (connection) => {
        await requireVisibleGroup(connection, principal, groupID)
        return (
          await connection.all<MemberRow>(
            `SELECT group_id, employee_id, added_by_employee_id, created_at
             FROM market_group_members
             WHERE group_id = ?
             ORDER BY employee_id`,
            [groupID],
          )
        ).map(member)
      })
    },

    addMember(principal: Principal, groupID: string, input: SkillMarketControl.GroupMemberInput) {
      requireGroupID(groupID)
      const decoded = Schema.decodeUnknownOption(SkillMarketControl.GroupMemberInput)(input)
      if (Option.isNone(decoded)) throw invalid("group member is invalid")
      const now = options.now?.() ?? Date.now()
      return options.database.transaction(async (connection) => {
        const current = await requireMutableGroup(connection, principal, groupID, decoded.value.expectedVersion)
        const existing = (
          await connection.get<{ count: number }>(
            "SELECT count(*) AS count FROM market_group_members WHERE group_id = ? AND employee_id = ?",
            [groupID, decoded.value.employeeID],
          )
        )?.count ?? 0
        if (existing > 0) throw invalid("group member already exists")
        await connection.run(
          `INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at)
           VALUES (?, ?, ?, ?)`,
          [groupID, decoded.value.employeeID, principal.session.user.employeeID, now],
        )
        await connection.run("UPDATE market_groups SET version = version + 1, updated_at = ? WHERE id = ?", [now, groupID])
        await insertAudit(connection, {
          actorEmployeeID: principal.session.user.employeeID,
          action: "group-member-added",
          objectID: groupID,
          before: { version: current.version },
          after: { employeeID: decoded.value.employeeID, version: current.version + 1 },
          now,
        })
        const row = await connection.get<MemberRow>(
          `SELECT group_id, employee_id, added_by_employee_id, created_at
               FROM market_group_members WHERE group_id = ? AND employee_id = ?`,
          [groupID, decoded.value.employeeID],
        )
        if (!row) throw new SkillMarketSecurityError("not-found", "group member was not found")
        return member(row)
      })
    },

    removeMember(
      principal: Principal,
      groupID: string,
      employeeID: string,
      input: SkillMarketControl.GroupMemberRemoveInput,
    ) {
      requireGroupID(groupID)
      if (!Schema.is(SkillMarketControl.EmployeeID)(employeeID)) throw invalid("group member is invalid")
      const decoded = Schema.decodeUnknownOption(SkillMarketControl.GroupMemberRemoveInput)(input)
      if (Option.isNone(decoded)) throw invalid("group member removal is invalid")
      const now = options.now?.() ?? Date.now()
      return options.database.transaction(async (connection) => {
        const current = await requireMutableGroup(connection, principal, groupID, decoded.value.expectedVersion)
        if (current.owner_employee_id === employeeID) throw invalid("cannot remove the current owner")
        const existing = await connection.get<MemberRow>(
          `SELECT group_id, employee_id, added_by_employee_id, created_at
             FROM market_group_members WHERE group_id = ? AND employee_id = ?`,
          [groupID, employeeID],
        )
        if (!existing) throw new SkillMarketSecurityError("not-found", "group member was not found")
        await connection.run("DELETE FROM market_group_members WHERE group_id = ? AND employee_id = ?", [groupID, employeeID])
        await connection.run("UPDATE market_groups SET version = version + 1, updated_at = ? WHERE id = ?", [now, groupID])
        await insertAudit(connection, {
          actorEmployeeID: principal.session.user.employeeID,
          action: "group-member-removed",
          objectID: groupID,
          before: { employeeID, version: current.version },
          after: { version: current.version + 1 },
          now,
        })
        return group(await requireGroup(connection, groupID))
      })
    },
  }
}

export type Groups = ReturnType<typeof createGroups>

function groupSelect() {
  return `SELECT
    market_groups.id,
    market_groups.name,
    market_groups.description,
    market_groups.owner_employee_id,
    market_groups.status,
    market_groups.version,
    market_groups.created_at,
    market_groups.updated_at
   FROM market_groups`
}

async function requireGroup(connection: Connection, groupID: string) {
  const row = await connection.get<GroupRow>(`${groupSelect()} WHERE market_groups.id = ?`, [groupID])
  if (row) return row
  throw new SkillMarketSecurityError("not-found", "group was not found")
}

async function requireVisibleGroup(connection: Connection, principal: Principal, groupID: string) {
  const row = await requireGroup(connection, groupID)
  if (principal.session.roles.includes("admin")) return row
  const membership = (
    await connection.get<{ count: number }>(
      "SELECT count(*) AS count FROM market_group_members WHERE group_id = ? AND employee_id = ?",
      [groupID, principal.session.user.employeeID],
    )
  )?.count ?? 0
  if (membership > 0) return row
  throw new SkillMarketSecurityError("not-found", "group was not found")
}

async function requireMutableGroup(
  connection: Connection,
  principal: Principal,
  groupID: string,
  expectedVersion: number,
) {
  const row = await requireGroup(connection, groupID)
  if (row.owner_employee_id !== principal.session.user.employeeID && !principal.session.roles.includes("admin"))
    throw new SkillMarketSecurityError("forbidden", "group management is forbidden")
  if (row.version !== expectedVersion)
    throw new SkillMarketSecurityError("submission-conflict", "group version conflict")
  return row
}

function requireGroupID(groupID: string) {
  if (!Schema.is(SkillMarketControl.GroupID)(groupID)) throw invalid("group ID is invalid")
}

function invalid(message: string) {
  return new SkillMarketSecurityError("invalid-request", message)
}

function group(row: GroupRow) {
  return Schema.decodeUnknownSync(SkillMarketControl.MarketGroup)({
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    ownerEmployeeID: row.owner_employee_id,
    status: row.status,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  })
}

function member(row: MemberRow) {
  return Schema.decodeUnknownSync(SkillMarketControl.MarketGroupMember)({
    groupID: row.group_id,
    employeeID: row.employee_id,
    createdByEmployeeID: row.added_by_employee_id,
    createdAt: new Date(row.created_at).toISOString(),
  })
}

async function insertAudit(
  connection: Connection,
  event: {
    readonly actorEmployeeID: string
    readonly action: SkillMarketControl.AuditAction
    readonly objectID: string
    readonly before?: object
    readonly after?: object
    readonly now: number
  },
) {
  await connection.run(
    `INSERT INTO audit_events
      (id, actor_employee_id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, ?, ?, 'group', ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      event.actorEmployeeID,
      event.action,
      event.objectID,
      event.before ? JSON.stringify(event.before) : null,
      event.after ? JSON.stringify(event.after) : null,
      `req_${randomSecret()}`,
      event.now,
    ],
  )
}
