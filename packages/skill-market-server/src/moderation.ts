import type { Database } from "bun:sqlite"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Option, Schema } from "effect"
import type { MarketDatabase } from "./database"
import { decideDelist, pendingDelist } from "./lifecycle"
import type { MarketSecurity, Principal } from "./security"
import { randomSecret, SkillMarketSecurityError } from "./security"
import {
  readSubmissionDetail,
  submissionSummarySelect,
  type SubmissionSummaryRow,
  toSubmissionSummary,
} from "./submission-read"
import { assertSubmissionTransition } from "./submissions"

interface ModerationOptions {
  readonly database: MarketDatabase
  readonly security: MarketSecurity
  readonly now?: () => number
}

interface SubmissionRow {
  readonly id: string
  readonly owner_employee_id: string
  readonly status: SkillMarketControl.SubmissionStatus
  readonly current_revision: number
  readonly version: number
  readonly scan_json: string | null
  readonly private_package_key: string
  readonly package_sha256: string
  readonly package_size: number
  readonly metadata_json: string
}

interface RoleRow {
  readonly employee_id: string
  readonly display_name: string
  readonly email: string | null
  readonly disabled_at: number | null
  readonly role: SkillMarketControl.Role
  readonly created_by: string | null
  readonly created_at: number
}

interface AuditRow {
  readonly id: string
  readonly actor_employee_id: string | null
  readonly display_name: string | null
  readonly email: string | null
  readonly disabled_at: number | null
  readonly action: SkillMarketControl.AuditAction
  readonly object_type: SkillMarketControl.AuditObjectType
  readonly object_id: string
  readonly before_json: string | null
  readonly after_json: string | null
  readonly request_id: string
  readonly created_at: number
}

interface CommunityRow {
  readonly skill_id: string
  readonly current_version: string | null
  readonly public_status: SkillMarketControl.PublicStatus | null
  readonly version: number
}

interface RetryRow {
  readonly status: SkillMarketControl.SubmissionStatus
  readonly version: number
}

const AuditPayload = Schema.Record(Schema.String, Schema.Json)

const DecisionStatus = {
  approve: "publishing",
  request_changes: "changes_requested",
  reject: "rejected",
} as const satisfies Record<SkillMarketControl.ReviewDecision, SkillMarketControl.SubmissionStatus>

const DecisionAction = {
  approve: "review-approved",
  request_changes: "review-changes-requested",
  reject: "review-rejected",
} as const satisfies Record<SkillMarketControl.ReviewDecision, SkillMarketControl.AuditAction>

export class Moderation {
  constructor(private readonly options: ModerationOptions) {}

  listQueue(principal: Principal, query: SkillMarketControl.AdminSubmissionQuery) {
    this.options.security.requireReviewer(principal)
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.AdminSubmissionQuery)(query)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "review queue query is invalid")
    const createdFrom = decoded.value.createdFrom ? Date.parse(decoded.value.createdFrom) : null
    const createdTo = decoded.value.createdTo ? Date.parse(decoded.value.createdTo) : null
    const where = ` WHERE submissions.status != 'withdrawn'
      AND (submissions.target_scope != 'personal' OR submissions.source_publication_id IS NOT NULL)
      AND (? IS NULL OR submissions.status = ?)
      AND (? IS NULL OR json_extract(submission_revisions.scan_json, '$.risk') = ?)
      AND (? IS NULL OR submissions.owner_employee_id = ?)
      AND (? IS NULL OR submissions.created_at >= ?)
      AND (? IS NULL OR submissions.created_at <= ?)`
    return this.options.database.read((connection) => {
      const parameters = [
        decoded.value.status ?? null,
        decoded.value.status ?? null,
        decoded.value.risk ?? null,
        decoded.value.risk ?? null,
        decoded.value.submitter ?? null,
        decoded.value.submitter ?? null,
        createdFrom,
        createdFrom,
        createdTo,
        createdTo,
      ] as const
      const total = connection
        .query<
          { count: number },
          [
            SkillMarketControl.SubmissionStatus | null,
            SkillMarketControl.SubmissionStatus | null,
            SkillMarketControl.ScanReport["risk"] | null,
            SkillMarketControl.ScanReport["risk"] | null,
            string | null,
            string | null,
            number | null,
            number | null,
            number | null,
            number | null,
          ]
        >(
          `SELECT count(*) AS count FROM submissions
           INNER JOIN submission_revisions
             ON submission_revisions.submission_id = submissions.id
            AND submission_revisions.revision_number = submissions.current_revision${where}`,
        )
        .get(...parameters)!.count
      const items = connection
        .query<
          SubmissionSummaryRow,
          [
            SkillMarketControl.SubmissionStatus | null,
            SkillMarketControl.SubmissionStatus | null,
            SkillMarketControl.ScanReport["risk"] | null,
            SkillMarketControl.ScanReport["risk"] | null,
            string | null,
            string | null,
            number | null,
            number | null,
            number | null,
            number | null,
            number,
            number,
          ]
        >(`${submissionSummarySelect()}${where} ORDER BY submissions.updated_at DESC, submissions.id LIMIT ? OFFSET ?`)
        .all(...parameters, decoded.value.limit, (decoded.value.page - 1) * decoded.value.limit)
        .map(toSubmissionSummary)
      return Schema.decodeUnknownSync(SkillMarketControl.SubmissionPage)({
        total,
        page: decoded.value.page,
        limit: decoded.value.limit,
        items,
      })
    })
  }

  get(principal: Principal, submissionID: string) {
    this.options.security.requireReviewer(principal)
    const detail = this.options.database.read((connection) => {
      const visible = connection
        .query<{ count: number }, [string]>(
          `SELECT count(*) AS count FROM submissions
           WHERE id = ? AND (target_scope != 'personal' OR source_publication_id IS NOT NULL)`,
        )
        .get(submissionID)!.count
      return visible === 1 ? readSubmissionDetail(connection, submissionID) : undefined
    })
    if (detail) return detail
    throw new SkillMarketSecurityError("not-found", "submission was not found")
  }

  decide(principal: Principal, submissionID: string, input: SkillMarketControl.DecisionInput) {
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.DecisionInput)(input)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "review decision is invalid")
    const now = this.options.now?.() ?? Date.now()
    return this.options.database.transaction((connection) => {
      const submission = connection
        .query<SubmissionRow, [string]>(
          `SELECT
            submissions.id,
            submissions.owner_employee_id,
            submissions.status,
            submissions.current_revision,
            submissions.version,
            submission_revisions.scan_json,
            submission_revisions.private_package_key,
            submission_revisions.package_sha256,
            submission_revisions.package_size,
            submission_revisions.metadata_json
           FROM submissions
           INNER JOIN submission_revisions
             ON submission_revisions.submission_id = submissions.id
            AND submission_revisions.revision_number = submissions.current_revision
           WHERE submissions.id = ?
             AND (submissions.target_scope != 'personal' OR submissions.source_publication_id IS NOT NULL)`,
        )
        .get(submissionID)
      if (!submission) throw new SkillMarketSecurityError("not-found", "submission was not found")
      this.options.security.requireReviewTarget(principal, submission.owner_employee_id)
      if (decoded.value.expectedVersion !== submission.version)
        throw new SkillMarketSecurityError("submission-conflict", "submission version no longer matches")
      if (submission.status !== "pending_review")
        throw new SkillMarketSecurityError("submission-conflict", "submission is not pending review")
      if (decoded.value.decision !== "approve" && !decoded.value.comment)
        throw new SkillMarketSecurityError("invalid-request", "review comment is required")

      const scan = submission.scan_json
        ? decodeJson(SkillMarketControl.ScanReport, submission.scan_json)
        : { risk: "unknown" as const }
      if (
        decoded.value.decision === "approve" &&
        (scan.risk === "warning" || scan.risk === "danger") &&
        !decoded.value.acceptedRiskSummary
      )
        throw new SkillMarketSecurityError("invalid-request", "risk acceptance summary is required")
      const status = DecisionStatus[decoded.value.decision]
      assertSubmissionTransition(submission.status, status)

      connection.run(
        `INSERT INTO reviews
          (id, submission_id, revision_number, reviewer_employee_id, decision, comment, accepted_risk_summary,
           approved_package_key, approved_package_sha256, approved_package_size, approved_metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `rev_${randomSecret()}`,
          submissionID,
          submission.current_revision,
          principal.session.user.employeeID,
          decoded.value.decision,
          decoded.value.comment ?? null,
          decoded.value.acceptedRiskSummary ?? null,
          decoded.value.decision === "approve" ? submission.private_package_key : null,
          decoded.value.decision === "approve" ? submission.package_sha256 : null,
          decoded.value.decision === "approve" ? submission.package_size : null,
          decoded.value.decision === "approve" ? submission.metadata_json : null,
          now,
        ],
      )
      connection.run(
        "UPDATE submissions SET status = ?, version = version + 1, user_message = ?, updated_at = ? WHERE id = ?",
        [status, decoded.value.decision === "approve" ? null : (decoded.value.comment ?? null), now, submissionID],
      )
      if (status === "publishing")
        connection.run(
          `INSERT INTO publish_jobs (id, submission_id, kind, status, attempts, created_at, updated_at)
           VALUES (?, ?, 'publish', 'pending', 0, ?, ?)`,
          [`job_${randomSecret()}`, submissionID, now, now],
        )
      insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: DecisionAction[decoded.value.decision],
        objectType: "submission",
        objectID: submissionID,
        before: { status: submission.status, version: submission.version },
        after: { status, version: submission.version + 1 },
        now,
      })
      const detail = readSubmissionDetail(connection, submissionID)
      if (!detail) throw new Error("reviewed submission is missing")
      return detail
    })
  }

  retryPublish(principal: Principal, submissionID: string, input: SkillMarketControl.ExpectedVersionInput) {
    this.options.security.requireAdmin(principal)
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.ExpectedVersionInput)(input)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "publish retry is invalid")
    const now = this.options.now?.() ?? Date.now()
    return this.options.database.transaction((connection) => {
      const submission = connection
        .query<RetryRow, [string]>("SELECT status, version FROM submissions WHERE id = ?")
        .get(submissionID)
      if (!submission) throw new SkillMarketSecurityError("not-found", "submission was not found")
      if (submission.version !== decoded.value.expectedVersion || submission.status !== "publish_failed")
        throw new SkillMarketSecurityError("submission-conflict", "submission cannot be retried from this version")
      assertSubmissionTransition(submission.status, "publishing")
      const active = connection
        .query<
          { count: number },
          [string]
        >("SELECT count(*) AS count FROM publish_jobs WHERE submission_id = ? AND status IN ('pending', 'running')")
        .get(submissionID)!.count
      if (active > 0)
        throw new SkillMarketSecurityError("submission-conflict", "submission already has an active publish job")
      const failed = connection
        .query<
          { id: string },
          [string]
        >("SELECT id FROM publish_jobs WHERE submission_id = ? AND kind = 'publish' AND status = 'failed' ORDER BY updated_at DESC, id LIMIT 1")
        .get(submissionID)
      if (failed)
        connection.run(
          `UPDATE publish_jobs
           SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
               error_code = NULL, error_summary = NULL, updated_at = ?
           WHERE id = ?`,
          [now, failed.id],
        )
      if (!failed)
        connection.run(
          `INSERT INTO publish_jobs (id, submission_id, kind, status, attempts, created_at, updated_at)
           VALUES (?, ?, 'publish', 'pending', 0, ?, ?)`,
          [`job_${randomSecret()}`, submissionID, now, now],
        )
      connection.run(
        "UPDATE submissions SET status = 'publishing', version = version + 1, user_message = NULL, updated_at = ? WHERE id = ?",
        [now, submissionID],
      )
      insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "publish-retried",
        objectType: "submission",
        objectID: submissionID,
        before: { status: submission.status, version: submission.version },
        after: { status: "publishing", version: submission.version + 1 },
        now,
      })
      const detail = readSubmissionDetail(connection, submissionID)
      if (!detail) throw new Error("retried submission is missing")
      return detail
    })
  }

  listRoles(principal: Principal) {
    this.options.security.requireAdmin(principal)
    return this.options.database.read(listRoles)
  }

  assignRole(principal: Principal, input: SkillMarketControl.RoleInput) {
    this.options.security.requireAdmin(principal)
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.RoleInput)(input)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "role assignment is invalid")
    const now = this.options.now?.() ?? Date.now()
    return this.options.database.transaction((connection) => {
      connection.run(
        `INSERT INTO users (employee_id, display_name, created_at, last_login_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(employee_id) DO NOTHING`,
        [decoded.value.employeeID, decoded.value.employeeID, now, now],
      )
      const target = connection
        .query<
          { employee_id: string; display_name: string; email: string | null; disabled_at: number | null },
          [string]
        >("SELECT employee_id, display_name, email, disabled_at FROM users WHERE employee_id = ?")
        .get(decoded.value.employeeID)
      if (!target) throw new Error("role target user is missing after provisioning")
      const existing = connection
        .query<
          { count: number },
          [string, SkillMarketControl.Role]
        >("SELECT count(*) AS count FROM role_assignments WHERE employee_id = ? AND role = ?")
        .get(decoded.value.employeeID, decoded.value.role)!.count
      if (existing > 0) throw new SkillMarketSecurityError("invalid-request", "role is already assigned")
      connection.run("INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, ?, ?, ?)", [
        decoded.value.employeeID,
        decoded.value.role,
        principal.session.user.employeeID,
        now,
      ])
      insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "role-assigned",
        objectType: "role",
        objectID: `${decoded.value.employeeID}:${decoded.value.role}`,
        after: { employeeID: decoded.value.employeeID, role: decoded.value.role },
        now,
      })
      return roleAssignment({
        ...target,
        role: decoded.value.role,
        created_by: principal.session.user.employeeID,
        created_at: now,
      })
    })
  }

  removeRole(principal: Principal, employeeID: string, role: SkillMarketControl.Role) {
    this.options.security.requireAdmin(principal)
    if (!Schema.is(SkillMarketControl.EmployeeID)(employeeID) || !Schema.is(SkillMarketControl.Role)(role))
      throw new SkillMarketSecurityError("invalid-request", "role removal is invalid")
    const now = this.options.now?.() ?? Date.now()
    return this.options.database.transaction((connection) => {
      const existing = connection
        .query<
          { count: number },
          [string, SkillMarketControl.Role]
        >("SELECT count(*) AS count FROM role_assignments WHERE employee_id = ? AND role = ?")
        .get(employeeID, role)!.count
      if (existing === 0) throw new SkillMarketSecurityError("not-found", "role assignment was not found")
      const admins = connection
        .query<{ count: number }, []>("SELECT count(*) AS count FROM role_assignments WHERE role = 'admin'")
        .get()!.count
      if (role === "admin" && admins === 1)
        throw new SkillMarketSecurityError("last-admin", "the last admin cannot be removed")
      connection.run("DELETE FROM role_assignments WHERE employee_id = ? AND role = ?", [employeeID, role])
      insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "role-removed",
        objectType: "role",
        objectID: `${employeeID}:${role}`,
        before: { employeeID, role },
        now,
      })
      return listRoles(connection)
    })
  }

  listAudit(principal: Principal, query: SkillMarketControl.AuditQuery) {
    this.options.security.requireAdmin(principal)
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.AuditQuery)(query)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "audit query is invalid")
    const createdFrom = decoded.value.createdFrom ? Date.parse(decoded.value.createdFrom) : null
    const createdTo = decoded.value.createdTo ? Date.parse(decoded.value.createdTo) : null
    const where = ` WHERE (? IS NULL OR audit_events.actor_employee_id = ?)
      AND (? IS NULL OR audit_events.action = ?)
      AND (? IS NULL OR audit_events.object_type = ?)
      AND (? IS NULL OR audit_events.object_id = ?)
      AND (? IS NULL OR audit_events.created_at >= ?)
      AND (? IS NULL OR audit_events.created_at <= ?)`
    return this.options.database.read((connection) => {
      const parameters = [
        decoded.value.actor ?? null,
        decoded.value.actor ?? null,
        decoded.value.action ?? null,
        decoded.value.action ?? null,
        decoded.value.objectType ?? null,
        decoded.value.objectType ?? null,
        decoded.value.objectID ?? null,
        decoded.value.objectID ?? null,
        createdFrom,
        createdFrom,
        createdTo,
        createdTo,
      ] as const
      const total = connection
        .query<
          { count: number },
          [
            string | null,
            string | null,
            SkillMarketControl.AuditAction | null,
            SkillMarketControl.AuditAction | null,
            SkillMarketControl.AuditObjectType | null,
            SkillMarketControl.AuditObjectType | null,
            string | null,
            string | null,
            number | null,
            number | null,
            number | null,
            number | null,
          ]
        >(`SELECT count(*) AS count FROM audit_events${where}`)
        .get(...parameters)!.count
      const items = connection
        .query<
          AuditRow,
          [
            string | null,
            string | null,
            SkillMarketControl.AuditAction | null,
            SkillMarketControl.AuditAction | null,
            SkillMarketControl.AuditObjectType | null,
            SkillMarketControl.AuditObjectType | null,
            string | null,
            string | null,
            number | null,
            number | null,
            number | null,
            number | null,
            number,
            number,
          ]
        >(
          `SELECT
             audit_events.id,
             audit_events.actor_employee_id,
             users.display_name,
             users.email,
             users.disabled_at,
             audit_events.action,
             audit_events.object_type,
             audit_events.object_id,
             audit_events.before_json,
             audit_events.after_json,
             audit_events.request_id,
             audit_events.created_at
           FROM audit_events
           LEFT JOIN users ON users.employee_id = audit_events.actor_employee_id${where}
           ORDER BY audit_events.created_at DESC, audit_events.rowid DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters, decoded.value.limit, (decoded.value.page - 1) * decoded.value.limit)
        .map(auditEvent)
      return Schema.decodeUnknownSync(SkillMarketControl.AuditPage)({
        total,
        page: decoded.value.page,
        limit: decoded.value.limit,
        items,
      })
    })
  }

  delist(principal: Principal, skillID: string, input: SkillMarketControl.ReasonInput) {
    return this.setCommunityStatus(principal, skillID, input, "delisted")
  }

  decideDelist(
    principal: Principal,
    requestID: string,
    input: SkillMarketControl.ExpectedVersionInput,
    decision: "approved" | "rejected",
  ) {
    this.options.security.requireAdmin(principal)
    if (
      !Schema.is(SkillMarketControl.DelistRequestID)(requestID) ||
      !Schema.is(SkillMarketControl.ExpectedVersionInput)(input)
    )
      throw new SkillMarketSecurityError("invalid-request", "delist decision is invalid")
    return this.options.database.transaction((connection) =>
      decideDelist(
        connection,
        principal,
        requestID,
        input.expectedVersion,
        decision,
        this.options.now?.() ?? Date.now(),
      ),
    )
  }

  pendingDelist(principal: Principal, submissionID: string) {
    this.options.security.requireAdmin(principal)
    if (!Schema.is(SkillMarketControl.SubmissionID)(submissionID))
      throw new SkillMarketSecurityError("invalid-request", "submission ID is invalid")
    return this.options.database.transaction((connection) => pendingDelist(connection, submissionID))
  }

  restore(principal: Principal, skillID: string, input: SkillMarketControl.ReasonInput) {
    return this.setCommunityStatus(principal, skillID, input, "published")
  }

  private setCommunityStatus(
    principal: Principal,
    skillID: string,
    input: SkillMarketControl.ReasonInput,
    status: SkillMarketControl.PublicStatus,
  ) {
    this.options.security.requireAdmin(principal)
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.ReasonInput)(input)
    if (Option.isNone(decoded) || !Schema.is(SkillMarketControl.SubmissionSummary.fields.skillID)(skillID))
      throw new SkillMarketSecurityError("invalid-request", "community status update is invalid")
    const now = this.options.now?.() ?? Date.now()
    return this.options.database.transaction((connection) => {
      const skill = connection
        .query<
          CommunityRow,
          [string]
        >("SELECT skill_id, current_version, public_status, version FROM community_skills WHERE skill_id = ?")
        .get(skillID)
      if (!skill?.current_version || !skill.public_status)
        throw new SkillMarketSecurityError("not-found", "published community skill was not found")
      if (skill.version !== decoded.value.expectedVersion)
        throw new SkillMarketSecurityError("submission-conflict", "community skill version no longer matches")
      const expectedStatus = status === "delisted" ? "published" : "delisted"
      if (skill.public_status !== expectedStatus)
        throw new SkillMarketSecurityError("submission-conflict", "community skill cannot change to this status")
      connection.run(
        "UPDATE community_skills SET public_status = ?, delist_reason = ?, version = version + 1, updated_at = ? WHERE skill_id = ?",
        [status, status === "delisted" ? decoded.value.reason : null, now, skillID],
      )
      enqueueCatalogRebuild(connection, now)
      insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: status === "delisted" ? "community-delisted" : "community-restored",
        objectType: "community_skill",
        objectID: skillID,
        before: { status: skill.public_status, version: skill.version },
        after: { status, version: skill.version + 1, reason: redactSensitive(decoded.value.reason) },
        now,
      })
      return Schema.decodeUnknownSync(SkillMarketControl.PublicSkill)({
        source: "community",
        id: skillID,
        version: skill.current_version,
        rowVersion: skill.version + 1,
        status,
      })
    })
  }
}

export function createModeration(options: ModerationOptions) {
  return new Moderation(options)
}

function insertAudit(
  connection: Database,
  event: {
    readonly actorEmployeeID: string
    readonly action: SkillMarketControl.AuditAction
    readonly objectType: SkillMarketControl.AuditObjectType
    readonly objectID: string
    readonly before?: object
    readonly after?: object
    readonly now: number
  },
) {
  connection.run(
    `INSERT INTO audit_events
      (id, actor_employee_id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      event.actorEmployeeID,
      event.action,
      event.objectType,
      event.objectID,
      event.before ? JSON.stringify(event.before) : null,
      event.after ? JSON.stringify(event.after) : null,
      `req_${randomSecret()}`,
      event.now,
    ],
  )
}

function listRoles(connection: Database) {
  return connection
    .query<RoleRow, []>(
      `SELECT
        users.employee_id,
        users.display_name,
        users.email,
        users.disabled_at,
        role_assignments.role,
        role_assignments.created_by,
        role_assignments.created_at
       FROM role_assignments
       INNER JOIN users ON users.employee_id = role_assignments.employee_id
       ORDER BY users.employee_id, role_assignments.role`,
    )
    .all()
    .map(roleAssignment)
}

function roleAssignment(row: RoleRow) {
  if (!row.created_by) throw new Error("role assignment creator is missing")
  return Schema.decodeUnknownSync(SkillMarketControl.RoleAssignment)({
    user: user(row),
    role: row.role,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at),
  })
}

function auditEvent(row: AuditRow) {
  return Schema.decodeUnknownSync(SkillMarketControl.AuditEvent)({
    id: row.id,
    ...(row.actor_employee_id && row.display_name ? { actor: user(row) } : {}),
    action: row.action,
    objectType: row.object_type,
    objectID: row.object_id,
    ...(row.before_json ? { before: decodeJson(AuditPayload, row.before_json) } : {}),
    ...(row.after_json ? { after: decodeJson(AuditPayload, row.after_json) } : {}),
    requestID: row.request_id,
    createdAt: timestamp(row.created_at),
  })
}

function user(row: {
  readonly employee_id?: string
  readonly actor_employee_id?: string | null
  readonly display_name: string | null
  readonly email: string | null
  readonly disabled_at: number | null
}) {
  const employeeID = row.employee_id ?? row.actor_employee_id
  if (!employeeID || !row.display_name) throw new Error("administration user identity is missing")
  return {
    employeeID,
    displayName: row.display_name,
    ...(row.email ? { email: row.email } : {}),
    ...(row.disabled_at !== null ? { disabledAt: timestamp(row.disabled_at) } : {}),
  }
}

function enqueueCatalogRebuild(connection: Database, now: number) {
  const active = connection
    .query<
      { count: number },
      []
    >("SELECT count(*) AS count FROM publish_jobs WHERE kind = 'catalog_rebuild' AND status = 'pending'")
    .get()!.count
  if (active > 0) return
  connection.run(
    `INSERT INTO publish_jobs (id, kind, status, attempts, created_at, updated_at)
     VALUES (?, 'catalog_rebuild', 'pending', 0, ?, ?)`,
    [`job_${randomSecret()}`, now, now],
  )
}

function decodeJson<S extends Schema.Decoder<unknown>>(schema: S, value: string): S["Type"] {
  return Schema.decodeUnknownSync(schema)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value))
}

function timestamp(value: number) {
  return new Date(value).toISOString()
}

function redactSensitive(value: string) {
  return value.replace(/\bsk-[a-zA-Z0-9_-]{32,}\b|\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
}
