import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import type { Connection } from "./store"
import { SkillMarketSecurityError } from "./security"
import type { Principal } from "./security"

export interface SubmissionAudienceRow {
  readonly target_scope: SkillMarketControl.PublicationTarget
  readonly target_department_id: string | null
  readonly target_department_name: string | null
  readonly target_group_ids_json: string
}

export async function requireAudienceTarget(
  connection: Connection,
  principal: Principal,
  target: SkillMarketControl.PublicationTarget,
  audience?: SkillMarketControl.AudienceInput,
): Promise<SkillMarketControl.AudienceTarget> {
  if (!Schema.is(SkillMarketControl.PublicationTarget)(target)) throw invalid("submission target is invalid")
  if (target === "personal" || target === "company") {
    if (audience !== undefined) throw invalid("unscoped submission target cannot include an audience")
    return { scope: target }
  }
  if (!Schema.is(SkillMarketControl.AudienceInput)(audience) || audience.scope !== target)
    throw invalid("submission audience does not match its target")
  if (target === "department") {
    const department = await connection.get<{ department_id: string | null; display_name: string | null }>(
      `SELECT users.department_id, departments.display_name
       FROM users
       LEFT JOIN departments ON departments.department_id = users.department_id
       WHERE users.employee_id = ?`,
      [principal.session.user.employeeID],
    )
    if (!department?.department_id || !department.display_name)
      throw new SkillMarketSecurityError("forbidden", "employee has no trusted department")
    return {
      scope: "department",
      department: { id: department.department_id, name: department.display_name },
    }
  }

  const groupIDs = [...new Set(audience.groupIDs)].toSorted()
  if (
    groupIDs.length < 1 ||
    groupIDs.length > 50 ||
    groupIDs.some((groupID) => !Schema.is(SkillMarketControl.GroupID)(groupID))
  )
    throw invalid("group audience must contain between one and fifty groups")
  const rows = await connection.all<{ id: string; owner_employee_id: string; status: "active" | "disabled" }>(
    `SELECT id, owner_employee_id, status
     FROM market_groups WHERE id IN (${groupIDs.map(() => "?").join(", ")})`,
    groupIDs,
  )
  const groups = new Map(rows.map((row) => [row.id, row]))
  const memberships = new Set(
    (
      await connection.all<{ group_id: string }>(
        `SELECT group_id FROM market_group_members
         WHERE employee_id = ? AND group_id IN (${groupIDs.map(() => "?").join(", ")})`,
        [principal.session.user.employeeID, ...groupIDs],
      )
    ).map((row) => row.group_id),
  )
  if (
    groupIDs.some((groupID) => {
      const group = groups.get(groupID)
      return (
        !group ||
        group.status !== "active" ||
        (group.owner_employee_id !== principal.session.user.employeeID &&
          !memberships.has(groupID) &&
          !principal.session.roles.includes("admin"))
      )
    })
  )
    throw new SkillMarketSecurityError("forbidden", "group publication authority is required")
  return { scope: "groups", groupIDs }
}

export async function insertSubmissionGroupTargets(
  connection: Connection,
  submissionID: string,
  audience: SkillMarketControl.AudienceTarget,
): Promise<void> {
  if (audience.scope !== "groups") return
  for (const groupID of audience.groupIDs) {
    await connection.run("INSERT INTO submission_group_targets (submission_id, group_id) VALUES (?, ?)", [
      submissionID,
      groupID,
    ])
  }
}

export function submissionAudience(row: SubmissionAudienceRow): SkillMarketControl.AudienceTarget | undefined {
  if (row.target_scope === "personal" || row.target_scope === "company") return undefined
  if (row.target_scope === "department") {
    if (!row.target_department_id || !row.target_department_name)
      throw new Error("department submission is missing its reviewed audience")
    return {
      scope: "department",
      department: { id: row.target_department_id, name: row.target_department_name },
    }
  }
  const groupIDs = Schema.decodeUnknownSync(Schema.Array(SkillMarketControl.GroupID))(
    Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(row.target_group_ids_json),
  )
  if (groupIDs.length < 1) throw new Error("group submission is missing its reviewed audience")
  return { scope: "groups", groupIDs }
}

export const RestrictedReadConditionSql = `(
  ? = 1 OR
  restricted_publications.owner_employee_id = ? OR
  (
    restricted_publications.scope = 'department'
    AND restricted_publications.department_id = (
      SELECT users.department_id FROM users WHERE users.employee_id = ?
    )
  ) OR
  (
    restricted_publications.scope = 'groups'
    AND EXISTS (
      SELECT 1
      FROM restricted_publication_groups
      INNER JOIN market_groups ON market_groups.id = restricted_publication_groups.group_id
      INNER JOIN market_group_members ON market_group_members.group_id = market_groups.id
      WHERE restricted_publication_groups.publication_id = restricted_publications.id
        AND market_groups.status = 'active'
        AND market_group_members.employee_id = ?
    )
  )
)`

export function restrictedReadParameters(principal: Principal) {
  return [
    Number(principal.session.roles.includes("admin")),
    principal.session.user.employeeID,
    principal.session.user.employeeID,
    principal.session.user.employeeID,
  ] as const
}

export async function canReadRestricted(connection: Connection, principal: Principal, publicationID: string) {
  return canReadRestrictedWithParameters(connection, publicationID, restrictedReadParameters(principal))
}

export async function canEmployeeReadRestricted(
  connection: Connection,
  employeeID: string,
  publicationID: string,
) {
  const user = await connection.get<{ disabled_at: number | null; admin: number }>(
    `SELECT users.disabled_at,
      EXISTS (
        SELECT 1 FROM role_assignments
        WHERE role_assignments.employee_id = users.employee_id AND role_assignments.role = 'admin'
      ) AS admin
     FROM users WHERE users.employee_id = ?`,
    [employeeID],
  )
  if (!user || user.disabled_at !== null) return false
  return canReadRestrictedWithParameters(connection, publicationID, [user.admin, employeeID, employeeID, employeeID])
}

async function canReadRestrictedWithParameters(
  connection: Connection,
  publicationID: string,
  parameters: readonly [number, string, string, string],
) {
  if (!Schema.is(SkillMarketControl.PublicationID)(publicationID)) return false
  const row = await connection.get<{ allowed: number }>(
    `SELECT 1 AS allowed
     FROM restricted_publications
     WHERE restricted_publications.id = ?
       AND restricted_publications.status = 'published'
       AND ${RestrictedReadConditionSql}
     LIMIT 1`,
    [publicationID, ...parameters],
  )
  return Boolean(row?.allowed)
}

function invalid(message: string) {
  return new SkillMarketSecurityError("invalid-request", message)
}
