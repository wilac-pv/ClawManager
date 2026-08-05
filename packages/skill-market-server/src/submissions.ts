import type { Database } from "bun:sqlite"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Option, Schema } from "effect"
import { insertSubmissionGroupTargets, requireAudienceTarget, submissionAudience } from "./audience"
import type { MarketDatabase } from "./database"
import type { Principal } from "./security"
import { randomSecret, SkillMarketSecurityError } from "./security"

const ActiveStatusSql =
  "'validating', 'validation_failed', 'pending_review', 'changes_requested', 'publishing', 'publish_failed'"
const DayMilliseconds = 24 * 60 * 60 * 1_000
const IdempotencyMilliseconds = 24 * 60 * 60 * 1_000

export interface SubmissionsOptions {
  readonly database: MarketDatabase
  readonly now?: () => number
  readonly onValidationReady?: (work: {
    readonly submissionID: string
    readonly revision: number
  }) => void | Promise<void>
}

export interface SubmissionPackage {
  readonly key: string
  readonly sha256: string
  readonly size: number
}

export interface SubmissionIcon extends SubmissionPackage {
  readonly mime: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml"
}

export interface CreateSubmissionInput {
  readonly idempotencyKey: string
  readonly target?: SkillMarketControl.PublicationTarget
  readonly audience?: SkillMarketControl.AudienceInput
  readonly submissionID: SkillMarketControl.SubmissionID
  readonly verifiedSkillID: string
  readonly metadata: SkillMarketControl.SubmissionMetadata
  readonly package: SubmissionPackage
  readonly icon?: SubmissionIcon
}

export interface PromotionRequestInput extends SkillMarketControl.PromotionInput {
  readonly idempotencyKey: string
}

export interface AudienceChangeRequestInput extends SkillMarketControl.AudienceChangeInput {
  readonly idempotencyKey: string
}

export interface AddRevisionInput {
  readonly idempotencyKey: string
  readonly expectedVersion: number
  readonly metadata: SkillMarketControl.SubmissionMetadata
  readonly package: SubmissionPackage
  readonly icon?: SubmissionIcon
}

export interface CompleteValidationInput {
  readonly submissionID: string
  readonly revision: number
  readonly manifest: SkillMarketControl.Manifest
  readonly scan: SkillMarketControl.ScanReport
  readonly validationIssues: ReadonlyArray<SkillMarketControl.ValidationIssue>
}

interface SummaryRow {
  readonly id: string
  readonly skill_id: string
  readonly owner_employee_id: string
  readonly display_name: string
  readonly email: string | null
  readonly disabled_at: number | null
  readonly target_version: string
  readonly target_scope: SkillMarketControl.PublicationTarget
  readonly target_department_id: string | null
  readonly target_department_name: string | null
  readonly target_group_ids_json: string
  readonly status: SkillMarketControl.SubmissionStatus
  readonly current_revision: number
  readonly version: number
  readonly scan_json: string | null
  readonly current_version: string | null
  readonly created_at: number
  readonly updated_at: number
}

interface SubmissionRow {
  readonly id: string
  readonly skill_id: string
  readonly owner_employee_id: string
  readonly target_version: string
  readonly target_scope: SkillMarketControl.PublicationTarget
  readonly target_department_id: string | null
  readonly source_publication_id: string | null
  readonly status: SkillMarketControl.SubmissionStatus
  readonly current_revision: number
  readonly version: number
}

interface SharingSourceRow extends SubmissionRow {
  readonly private_package_key: string
  readonly package_sha256: string
  readonly package_size: number
  readonly metadata_json: string
  readonly private_icon_json: string | null
  readonly manifest_json: string | null
  readonly scan_json: string | null
  readonly validation_errors_json: string | null
  readonly publication_id: string | null
}

interface RevisionRow {
  readonly revision_number: number
  readonly metadata_json: string
  readonly manifest_json: string | null
  readonly scan_json: string | null
  readonly validation_errors_json: string | null
  readonly created_at: number
}

interface AuditRow {
  readonly after_json: string | null
  readonly created_at: number
  readonly actor_employee_id: string | null
  readonly display_name: string | null
  readonly email: string | null
  readonly disabled_at: number | null
}

interface ReviewRow {
  readonly revision_number: number
  readonly decision: SkillMarketControl.ReviewDecision
  readonly comment: string | null
  readonly accepted_risk_summary: string | null
  readonly created_at: number
  readonly employee_id: string
  readonly display_name: string
  readonly email: string | null
  readonly disabled_at: number | null
}

const AuditAfter = Schema.Struct({
  status: SkillMarketControl.SubmissionStatus,
  message: Schema.optional(Schema.String),
})

const submissionTransitions = {
  validating: ["validation_failed", "pending_review"],
  validation_failed: ["validating"],
  pending_review: ["changes_requested", "rejected", "publishing"],
  changes_requested: ["validating"],
  rejected: [],
  publishing: ["publish_failed", "published"],
  publish_failed: ["publishing"],
  published: [],
} as const satisfies Record<SkillMarketControl.SubmissionStatus, ReadonlyArray<SkillMarketControl.SubmissionStatus>>

export function assertSubmissionTransition(
  from: SkillMarketControl.SubmissionStatus,
  to: SkillMarketControl.SubmissionStatus,
) {
  const allowed: ReadonlyArray<SkillMarketControl.SubmissionStatus> = submissionTransitions[from]
  if (allowed.includes(to)) return to
  throw new SkillMarketSecurityError(
    "submission-conflict",
    `submission status transition ${from} -> ${to} is not allowed`,
  )
}

export class Submissions {
  constructor(private readonly options: SubmissionsOptions) {}

  listOwn(principal: Principal, query: SkillMarketControl.SubmissionListQuery) {
    if (!Schema.is(SkillMarketControl.SubmissionListQuery)(query))
      throw new SkillMarketSecurityError("invalid-request", "submission list query is invalid")
    const filters = ["submissions.owner_employee_id = ?"]
    const parameters: Array<string | number> = [principal.session.user.employeeID]
    if (query.status) {
      filters.push("submissions.status = ?")
      parameters.push(query.status)
    }
    if (query.target) {
      filters.push("submissions.target_scope = ?")
      parameters.push(query.target)
    }
    const where = ` WHERE ${filters.join(" AND ")}`
    const total = this.options.database.connection
      .query<{ count: number }, Array<string | number>>(`SELECT count(*) AS count FROM submissions${where}`)
      .get(...parameters)!.count
    const rows = this.options.database.connection
      .query<SummaryRow, Array<string | number>>(
        `${summarySql()}${where}
         ORDER BY submissions.updated_at DESC, submissions.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...parameters, query.limit, (query.page - 1) * query.limit)
    return Schema.decodeUnknownSync(SkillMarketControl.SubmissionPage)({
      total,
      page: query.page,
      limit: query.limit,
      items: rows.map(summary),
    })
  }

  getOwn(principal: Principal, submissionID: string) {
    const row = this.options.database.connection
      .query<
        SummaryRow,
        [string, string]
      >(`${summarySql()} WHERE submissions.id = ? AND submissions.owner_employee_id = ?`)
      .get(submissionID, principal.session.user.employeeID)
    if (!row) throw new SkillMarketSecurityError("not-found", "submission was not found")

    const revisions = this.options.database.connection
      .query<RevisionRow, [string]>(
        `SELECT revision_number, metadata_json, manifest_json, scan_json, validation_errors_json, created_at
         FROM submission_revisions WHERE submission_id = ? ORDER BY revision_number`,
      )
      .all(submissionID)
      .map((revision) => ({
        number: revision.revision_number,
        metadata: decodeJson(SkillMarketControl.SubmissionMetadata, revision.metadata_json),
        ...(revision.manifest_json
          ? { manifest: decodeJson(SkillMarketControl.Manifest, revision.manifest_json) }
          : {}),
        ...(revision.scan_json ? { scan: decodeJson(SkillMarketControl.ScanReport, revision.scan_json) } : {}),
        validationIssues: revision.validation_errors_json
          ? decodeJson(Schema.Array(SkillMarketControl.ValidationIssue), revision.validation_errors_json)
          : [],
        createdAt: timestamp(revision.created_at),
      }))
    const reviews = this.options.database.connection
      .query<ReviewRow, [string]>(
        `SELECT
          reviews.revision_number,
          reviews.decision,
          reviews.comment,
          reviews.accepted_risk_summary,
          reviews.created_at,
          users.employee_id,
          users.display_name,
          users.email,
          users.disabled_at
         FROM reviews
         INNER JOIN users ON users.employee_id = reviews.reviewer_employee_id
         WHERE reviews.submission_id = ?
         ORDER BY reviews.created_at, reviews.id`,
      )
      .all(submissionID)
      .map((review) => ({
        revision: review.revision_number,
        reviewer: user(review),
        decision: review.decision,
        ...(review.comment ? { comment: review.comment } : {}),
        ...(review.accepted_risk_summary ? { acceptedRiskSummary: review.accepted_risk_summary } : {}),
        createdAt: timestamp(review.created_at),
      }))
    const timeline = this.options.database.connection
      .query<AuditRow, [string]>(
        `SELECT
          audit_events.after_json,
          audit_events.created_at,
          audit_events.actor_employee_id,
          users.display_name,
          users.email,
          users.disabled_at
         FROM audit_events
         LEFT JOIN users ON users.employee_id = audit_events.actor_employee_id
         WHERE audit_events.object_type = 'submission' AND audit_events.object_id = ?
         ORDER BY audit_events.created_at, audit_events.rowid`,
      )
      .all(submissionID)
      .flatMap((event) => {
        if (!event.after_json) return []
        const decoded = decodeJsonOption(AuditAfter, event.after_json)
        if (!decoded) return []
        return [
          {
            status: decoded.status,
            at: timestamp(event.created_at),
            ...(event.actor_employee_id && event.display_name
              ? {
                  actor: user({
                    employee_id: event.actor_employee_id,
                    display_name: event.display_name,
                    email: event.email,
                    disabled_at: event.disabled_at,
                  }),
                }
              : {}),
            ...(decoded.message ? { message: decoded.message } : {}),
          },
        ]
      })
    const community =
      row.target_scope === "company"
        ? this.options.database.connection
            .query<
              {
                current_version: string | null
                public_status: SkillMarketControl.PublicStatus | null
                row_version: number
              },
              [string]
            >("SELECT current_version, public_status, version AS row_version FROM community_skills WHERE skill_id = ?")
            .get(row.skill_id)
        : undefined
    const currentMetadata = revisions.find((revision) => revision.number === row.current_revision)?.metadata
    if (!currentMetadata) throw new Error("submission current revision is missing")
    return Schema.decodeUnknownSync(SkillMarketControl.SubmissionDetail)({
      ...summary(row),
      metadata: currentMetadata,
      revisions,
      reviews,
      timeline,
      ...(community?.current_version && community.public_status
        ? {
            publicSkill: {
              source: "community",
              id: row.skill_id,
              version: community.current_version,
              rowVersion: community.row_version,
              status: community.public_status,
            },
          }
        : {}),
    })
  }

  async create(principal: Principal, input: CreateSubmissionInput) {
    const now = this.options.now?.() ?? Date.now()
    const metadata = requireMetadata(input.metadata)
    const packageObject = requirePackage(input.package)
    const icon = requireIcon(input.icon)
    const submissionID = requireSubmissionID(input.submissionID)
    const skillID = requireSkillID(input.verifiedSkillID)
    if (input.target !== undefined && !Schema.is(SkillMarketControl.PublicationTarget)(input.target))
      throw new SkillMarketSecurityError("invalid-request", "submission target is invalid")
    const target = input.target ?? "company"
    const route = "submissions:create"
    const key = requireIdempotencyKey(input.idempotencyKey)
    const requestHash = hashJson({
      target,
      audience: input.audience,
      skillID,
      metadata,
      ...artifactIdentity(packageObject, icon),
    })
    const state = this.options.database.transaction((connection) => {
      const replay = readIdempotency(connection, principal, route, key, requestHash, now)
      if (replay) return { response: replay, queued: undefined }
      requireActiveUser(connection, principal)
      requireUploadAllowance(connection, principal, now)
      requireActiveAllowance(connection, principal)
      const audience = requireAudienceTarget(connection, principal, target, input.audience)
      requireOwnershipAndVersion(connection, principal, target, skillID, metadata.version)

      if (
        connection
          .query<{ count: number }, [string]>("SELECT count(*) AS count FROM submissions WHERE id = ?")
          .get(submissionID)!.count > 0
      )
        throw new SkillMarketSecurityError("submission-conflict", "submission ID has already been used")
      connection.run(
        `INSERT INTO submissions
          (id, skill_id, owner_employee_id, target_version, target_scope, target_department_id,
           status, current_revision, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'validating', 1, 1, ?, ?)`,
        [
          submissionID,
          skillID,
          principal.session.user.employeeID,
          metadata.version,
          target,
          audience.scope === "department" ? audience.department.id : null,
          now,
          now,
        ],
      )
      insertSubmissionGroupTargets(connection, submissionID, audience)
      insertRevision(connection, submissionID, 1, metadata, packageObject, icon, now)
      insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "submission-created",
        submissionID,
        after: {
          status: "validating",
          revision: 1,
          target,
          ...(audience.scope === "groups" ? { groupIDs: audience.groupIDs } : {}),
          ...(audience.scope === "department" ? { departmentID: audience.department.id } : {}),
        },
        now,
      })
      const response = { submission: requireSummary(connection, submissionID) }
      writeIdempotency(connection, principal, route, key, requestHash, response, now)
      return { response, queued: { submissionID, revision: 1 } }
    })
    if (state.queued && this.options.onValidationReady)
      await Promise.resolve(this.options.onValidationReady(state.queued)).then(
        () => undefined,
        () => undefined,
      )
    return state.response
  }

  async addRevision(principal: Principal, submissionID: string, input: AddRevisionInput) {
    const now = this.options.now?.() ?? Date.now()
    const metadata = requireMetadata(input.metadata)
    const packageObject = requirePackage(input.package)
    const icon = requireIcon(input.icon)
    const route = `submissions:${submissionID}:revisions`
    const key = requireIdempotencyKey(input.idempotencyKey)
    const requestHash = hashJson({
      expectedVersion: input.expectedVersion,
      metadata,
      ...artifactIdentity(packageObject, icon),
    })
    const state = this.options.database.transaction((connection) => {
      const replay = readIdempotency(connection, principal, route, key, requestHash, now)
      if (replay) return { response: replay, queued: undefined }
      requireActiveUser(connection, principal)
      requireUploadAllowance(connection, principal, now)
      const submission = connection
        .query<SubmissionRow, [string, string]>(
          `SELECT id, skill_id, owner_employee_id, target_version, target_scope, target_department_id,
                  source_publication_id, status, current_revision, version
           FROM submissions WHERE id = ? AND owner_employee_id = ?`,
        )
        .get(submissionID, principal.session.user.employeeID)
      if (!submission) throw new SkillMarketSecurityError("not-found", "submission was not found")
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== submission.version)
        throw new SkillMarketSecurityError("submission-conflict", "submission version no longer matches")
      if (metadata.version !== submission.target_version)
        throw new SkillMarketSecurityError("submission-conflict", "a revision cannot change the target version")
      assertSubmissionTransition(submission.status, "validating")

      const revision = submission.current_revision + 1
      connection.run(
        `UPDATE submissions
         SET status = 'validating', current_revision = ?, version = version + 1, user_message = NULL, updated_at = ?
         WHERE id = ?`,
        [revision, now, submissionID],
      )
      insertRevision(connection, submissionID, revision, metadata, packageObject, icon, now)
      insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "revision-uploaded",
        submissionID,
        before: { status: submission.status, revision: submission.current_revision },
        after: { status: "validating", revision },
        now,
      })
      const response = { submission: requireSummary(connection, submissionID) }
      writeIdempotency(connection, principal, route, key, requestHash, response, now)
      return { response, queued: { submissionID, revision } }
    })
    if (state.queued && this.options.onValidationReady)
      await Promise.resolve(this.options.onValidationReady(state.queued)).then(
        () => undefined,
        () => undefined,
      )
    return state.response
  }

  completeValidation(input: CompleteValidationInput) {
    const now = this.options.now?.() ?? Date.now()
    if (
      !Schema.is(SkillMarketControl.Manifest)(input.manifest) ||
      !Schema.is(SkillMarketControl.ScanReport)(input.scan)
    )
      throw new SkillMarketSecurityError("validation-failed", "validation artifacts are invalid")
    if (!Schema.is(Schema.Array(SkillMarketControl.ValidationIssue))(input.validationIssues))
      throw new SkillMarketSecurityError("validation-failed", "validation issues are invalid")
    return this.options.database.transaction((connection) => {
      const submission = connection
        .query<SubmissionRow & { package_sha256: string; package_size: number }, [number, string]>(
          `SELECT
            submissions.id,
            submissions.skill_id,
            submissions.owner_employee_id,
            submissions.target_version,
            submissions.status,
            submissions.target_scope,
            submissions.target_department_id,
            submissions.source_publication_id,
            submissions.current_revision,
            submissions.version,
            submission_revisions.package_sha256,
            submission_revisions.package_size
           FROM submissions
           INNER JOIN submission_revisions
             ON submission_revisions.submission_id = submissions.id
            AND submission_revisions.revision_number = ?
           WHERE submissions.id = ?`,
        )
        .get(input.revision, input.submissionID)
      if (!submission) throw new SkillMarketSecurityError("not-found", "submission revision was not found")
      if (submission.current_revision !== input.revision)
        throw new SkillMarketSecurityError("submission-conflict", "submission revision is no longer current")
      if (
        submission.package_sha256 !== input.manifest.packageSha256 ||
        submission.package_size !== input.manifest.packageSize
      )
        throw new SkillMarketSecurityError("validation-failed", "validation package does not match the upload")

      const community =
        submission.target_scope === "company"
          ? connection
              .query<
                { owner_employee_id: string },
                [string]
              >("SELECT owner_employee_id FROM community_skills WHERE skill_id = ?")
              .get(submission.skill_id)
          : undefined
      const ownershipIssue =
        community && community.owner_employee_id !== submission.owner_employee_id
          ? [{ code: "skill-owned-by-another-user", message: "Skill ID belongs to another employee" }]
          : []
      const issues = [...input.validationIssues, ...ownershipIssue]
      const status =
        issues.length > 0
          ? "validation_failed"
          : submission.target_scope === "personal"
            ? "published"
            : "pending_review"
      if (status === "published") {
        if (submission.status !== "validating")
          throw new SkillMarketSecurityError("submission-conflict", "personal submission is no longer validating")
      } else assertSubmissionTransition(submission.status, status)

      connection.run(
        `UPDATE submission_revisions
         SET manifest_json = ?, scan_json = ?, validation_errors_json = ?, validation_completed_at = ?,
             validation_lease_owner = NULL, validation_lease_expires_at = NULL
         WHERE submission_id = ? AND revision_number = ?`,
        [
          JSON.stringify(input.manifest),
          JSON.stringify(input.scan),
          JSON.stringify(issues),
          now,
          input.submissionID,
          input.revision,
        ],
      )
      if (submission.target_scope === "company" && status === "pending_review" && !community)
        connection.run(
          `INSERT INTO community_skills
            (skill_id, owner_employee_id, version, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
          [submission.skill_id, submission.owner_employee_id, now, now],
        )
      connection.run("UPDATE submissions SET status = ?, version = version + 1, updated_at = ? WHERE id = ?", [
        status,
        now,
        input.submissionID,
      ])
      insertAudit(connection, {
        action: status === "validation_failed" ? "validation-failed" : "validation-succeeded",
        submissionID: input.submissionID,
        before: { status: submission.status, revision: input.revision },
        after: {
          status,
          revision: input.revision,
          ...(submission.target_scope === "personal" && status === "published"
            ? { message: "个人空间扫描通过，已可用" }
            : {}),
        },
        now,
      })
      return { submission: requireSummary(connection, input.submissionID) }
    })
  }

  async promote(principal: Principal, submissionID: string, input: PromotionRequestInput) {
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.PromotionInput)({
      expectedVersion: input.expectedVersion,
      target: input.target,
      ...(input.audience ? { audience: input.audience } : {}),
    })
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "promotion request is invalid")
    const now = this.options.now?.() ?? Date.now()
    const route = `submissions:${submissionID}:promotions`
    const key = requireIdempotencyKey(input.idempotencyKey)
    const requestHash = hashJson({ source: submissionID, ...decoded.value })
    const state = this.options.database.transaction((connection) => {
      const replay = readIdempotency(connection, principal, route, key, requestHash, now)
      if (replay) return { response: replay, queued: undefined }
      requireActiveUser(connection, principal)
      requireUploadAllowance(connection, principal, now)
      requireActiveAllowance(connection, principal)
      const source = requireSharingSource(connection, principal, submissionID)
      if (source.target_scope !== "personal" || source.status !== "published" || source.publication_id)
        throw new SkillMarketSecurityError("submission-conflict", "only a published personal Skill can be promoted")
      if (decoded.value.expectedVersion !== source.version)
        throw new SkillMarketSecurityError("submission-conflict", "submission version no longer matches")
      requireVerifiedSharingSource(source)
      const audience = requireAudienceTarget(connection, principal, decoded.value.target, decoded.value.audience)
      requireOwnershipAndVersion(connection, principal, decoded.value.target, source.skill_id, source.target_version)

      const promotedID = `sub_${randomSecret()}` as SkillMarketControl.SubmissionID
      insertSharingSubmission(connection, {
        id: promotedID,
        source,
        target: decoded.value.target,
        audience,
        now,
      })
      copySharingRevision(connection, source, promotedID, now, false)
      insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "submission-created",
        submissionID: promotedID,
        after: {
          status: "validating",
          revision: 1,
          target: decoded.value.target,
          sourceSubmissionID: source.id,
        },
        now,
      })
      const response = { submission: requireSummary(connection, promotedID) }
      writeIdempotency(connection, principal, route, key, requestHash, response, now)
      return { response, queued: { submissionID: promotedID, revision: 1 } }
    })
    if (state.queued && this.options.onValidationReady)
      await Promise.resolve(this.options.onValidationReady(state.queued)).then(
        () => undefined,
        () => undefined,
      )
    return state.response
  }

  async changeAudience(principal: Principal, submissionID: string, input: AudienceChangeRequestInput) {
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.AudienceChangeInput)({
      expectedVersion: input.expectedVersion,
      target: input.target,
      ...(input.audience ? { audience: input.audience } : {}),
    })
    if (Option.isNone(decoded))
      throw new SkillMarketSecurityError("invalid-request", "audience change request is invalid")
    const now = this.options.now?.() ?? Date.now()
    const route = `submissions:${submissionID}:audience-changes`
    const key = requireIdempotencyKey(input.idempotencyKey)
    const requestHash = hashJson({ source: submissionID, ...decoded.value })
    return this.options.database.transaction((connection) => {
      const replay = readIdempotency(connection, principal, route, key, requestHash, now)
      if (replay) return replay
      requireActiveUser(connection, principal)
      requireUploadAllowance(connection, principal, now)
      requireActiveAllowance(connection, principal)
      const source = requireSharingSource(connection, principal, submissionID)
      if (source.status !== "published" || !source.publication_id)
        throw new SkillMarketSecurityError(
          "submission-conflict",
          "only a published restricted Skill can change audience",
        )
      if (decoded.value.expectedVersion !== source.version)
        throw new SkillMarketSecurityError("submission-conflict", "submission version no longer matches")
      requireVerifiedSharingSource(source)
      requireAudienceChangeAllowance(connection, source.publication_id)
      const audience = requireAudienceTarget(connection, principal, decoded.value.target, decoded.value.audience)
      requireOwnershipAndVersion(
        connection,
        principal,
        decoded.value.target,
        source.skill_id,
        source.target_version,
        source.publication_id,
      )
      if (decoded.value.target === "company")
        reserveCommunitySkill(connection, source.skill_id, source.owner_employee_id, now)

      const changeID = `sub_${randomSecret()}` as SkillMarketControl.SubmissionID
      insertSharingSubmission(connection, {
        id: changeID,
        source,
        target: decoded.value.target,
        audience,
        sourcePublicationID: source.publication_id,
        now,
      })
      copySharingRevision(connection, source, changeID, now, true)
      connection.run(
        "UPDATE submissions SET status = 'pending_review', version = version + 1, updated_at = ? WHERE id = ?",
        [now, changeID],
      )
      insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "submission-created",
        submissionID: changeID,
        after: {
          status: "pending_review",
          revision: 1,
          target: decoded.value.target,
          sourceSubmissionID: source.id,
          sourcePublicationID: source.publication_id,
        },
        now,
      })
      const response = { submission: requireSummary(connection, changeID) }
      writeIdempotency(connection, principal, route, key, requestHash, response, now)
      return response
    })
  }

  personalPackage(principal: Principal, submissionID: string) {
    const row = this.options.database.connection
      .query<
        {
          skill_id: string
          target_version: string
          private_package_key: string
          package_sha256: string
          package_size: number
        },
        [string, string]
      >(
        `SELECT
          submissions.skill_id,
          submissions.target_version,
          submission_revisions.private_package_key,
          submission_revisions.package_sha256,
          submission_revisions.package_size
         FROM submissions
         INNER JOIN submission_revisions
           ON submission_revisions.submission_id = submissions.id
          AND submission_revisions.revision_number = submissions.current_revision
         WHERE submissions.id = ?
           AND submissions.owner_employee_id = ?
           AND submissions.target_scope = 'personal'
           AND submissions.status = 'published'`,
      )
      .get(submissionID, principal.session.user.employeeID)
    if (!row) throw new SkillMarketSecurityError("not-found", "personal Skill package was not found")
    return {
      key: row.private_package_key,
      sha256: row.package_sha256,
      size: row.package_size,
      filename: `${row.skill_id}-${row.target_version}.zip`.replace(/[^a-zA-Z0-9._-]/g, "_"),
    }
  }
}

export function createSubmissions(options: SubmissionsOptions) {
  return new Submissions(options)
}

function summarySql() {
  return `SELECT
    submissions.id,
    submissions.skill_id,
    submissions.owner_employee_id,
    users.display_name,
    users.email,
    users.disabled_at,
    submissions.target_version,
    submissions.target_scope,
    submissions.target_department_id,
    departments.display_name AS target_department_name,
    (
      SELECT json_group_array(group_id)
      FROM (
        SELECT submission_group_targets.group_id AS group_id
        FROM submission_group_targets
        WHERE submission_group_targets.submission_id = submissions.id
        ORDER BY submission_group_targets.group_id
      )
    ) AS target_group_ids_json,
    submissions.status,
    submissions.current_revision,
    submissions.version,
    submission_revisions.scan_json,
    community_skills.current_version,
    submissions.created_at,
    submissions.updated_at
   FROM submissions
   INNER JOIN users ON users.employee_id = submissions.owner_employee_id
   LEFT JOIN departments ON departments.department_id = submissions.target_department_id
   INNER JOIN submission_revisions
     ON submission_revisions.submission_id = submissions.id
    AND submission_revisions.revision_number = submissions.current_revision
   LEFT JOIN community_skills
     ON community_skills.skill_id = submissions.skill_id
    AND submissions.target_scope = 'company'`
}

function requireSummary(connection: Database, submissionID: string) {
  const row = connection.query<SummaryRow, [string]>(`${summarySql()} WHERE submissions.id = ?`).get(submissionID)
  if (!row) throw new Error("submission summary is missing")
  return summary(row)
}

function summary(row: SummaryRow) {
  const scan = row.scan_json ? decodeJsonOption(SkillMarketControl.ScanReport, row.scan_json) : undefined
  const audience = submissionAudience(row)
  return Schema.decodeUnknownSync(SkillMarketControl.SubmissionSummary)({
    id: row.id,
    skillID: row.skill_id,
    owner: user(row),
    targetVersion: row.target_version,
    target: row.target_scope,
    ...(audience ? { audience } : {}),
    status: row.status,
    currentRevision: row.current_revision,
    version: row.version,
    risk: scan?.risk ?? "unknown",
    ...(row.current_version ? { currentPublicVersion: row.current_version } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  })
}

function requireSharingSource(connection: Database, principal: Principal, submissionID: string) {
  const source = connection
    .query<SharingSourceRow, [string, string]>(
      `SELECT
        submissions.id,
        submissions.skill_id,
        submissions.owner_employee_id,
        submissions.target_version,
        submissions.target_scope,
        submissions.target_department_id,
        submissions.source_publication_id,
        submissions.status,
        submissions.current_revision,
        submissions.version,
        submission_revisions.private_package_key,
        submission_revisions.package_sha256,
        submission_revisions.package_size,
        submission_revisions.metadata_json,
        submission_revisions.private_icon_json,
        submission_revisions.manifest_json,
        submission_revisions.scan_json,
        submission_revisions.validation_errors_json,
        restricted_publications.id AS publication_id
       FROM submissions
       INNER JOIN submission_revisions
         ON submission_revisions.submission_id = submissions.id
        AND submission_revisions.revision_number = submissions.current_revision
       LEFT JOIN restricted_publications
         ON restricted_publications.submission_id = submissions.id
        AND restricted_publications.status = 'published'
       WHERE submissions.id = ? AND submissions.owner_employee_id = ?`,
    )
    .get(submissionID, principal.session.user.employeeID)
  if (source) return source
  throw new SkillMarketSecurityError("not-found", "submission was not found")
}

function requireVerifiedSharingSource(source: SharingSourceRow) {
  const issues = source.validation_errors_json
    ? decodeJsonOption(Schema.Array(SkillMarketControl.ValidationIssue), source.validation_errors_json)
    : undefined
  if (source.manifest_json && source.scan_json && issues?.length === 0) return
  throw new SkillMarketSecurityError("submission-conflict", "source submission is not verified")
}

function insertSharingSubmission(
  connection: Database,
  input: {
    readonly id: SkillMarketControl.SubmissionID
    readonly source: SharingSourceRow
    readonly target: SkillMarketControl.PublicationTarget
    readonly audience: SkillMarketControl.AudienceTarget
    readonly sourcePublicationID?: string
    readonly now: number
  },
) {
  connection.run(
    `INSERT INTO submissions
      (id, skill_id, owner_employee_id, target_version, target_scope, target_department_id,
       source_publication_id, status, current_revision, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'validating', 1, 1, ?, ?)`,
    [
      input.id,
      input.source.skill_id,
      input.source.owner_employee_id,
      input.source.target_version,
      input.target,
      input.audience.scope === "department" ? input.audience.department.id : null,
      input.sourcePublicationID ?? null,
      input.now,
      input.now,
    ],
  )
  insertSubmissionGroupTargets(connection, input.id, input.audience)
}

function copySharingRevision(
  connection: Database,
  source: SharingSourceRow,
  submissionID: string,
  now: number,
  verified: boolean,
) {
  connection.run(
    `INSERT INTO submission_revisions
      (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json,
       private_icon_json, manifest_json, scan_json, validation_errors_json, validation_completed_at, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      submissionID,
      source.private_package_key,
      source.package_sha256,
      source.package_size,
      source.metadata_json,
      source.private_icon_json,
      verified ? source.manifest_json : null,
      verified ? source.scan_json : null,
      verified ? source.validation_errors_json : null,
      verified ? now : null,
      now,
    ],
  )
}

function user(row: {
  readonly owner_employee_id?: string
  readonly employee_id?: string
  readonly display_name: string
  readonly email: string | null
  readonly disabled_at: number | null
}) {
  const employeeID = row.owner_employee_id ?? row.employee_id
  if (!employeeID) throw new Error("submission user identity is missing")
  return {
    employeeID,
    displayName: row.display_name,
    ...(row.email ? { email: row.email } : {}),
    ...(row.disabled_at !== null ? { disabledAt: timestamp(row.disabled_at) } : {}),
  }
}

function requireMetadata(value: SkillMarketControl.SubmissionMetadata) {
  const decoded = Schema.decodeUnknownOption(SkillMarketControl.SubmissionMetadata)(value)
  if (Option.isSome(decoded)) return decoded.value
  throw new SkillMarketSecurityError("invalid-request", "submission metadata is invalid")
}

function requirePackage(value: SubmissionPackage) {
  if (
    value &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isInteger(value.size) &&
    value.size > 0
  )
    return { key: value.key, sha256: value.sha256, size: value.size }
  throw new SkillMarketSecurityError("invalid-request", "submission package is invalid")
}

function requireIcon(value: SubmissionIcon | undefined): SubmissionIcon | undefined {
  if (!value) return undefined
  const icon = requirePackage(value)
  if (icon.size <= 1024 * 1024 && new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]).has(value.mime))
    return { ...icon, mime: value.mime }
  throw new SkillMarketSecurityError("invalid-request", "submission icon is invalid")
}

function requireSkillID(value: string) {
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) return value
  throw new SkillMarketSecurityError("invalid-request", "verified Skill ID is invalid")
}

function requireSubmissionID(value: string) {
  if (Schema.is(SkillMarketControl.SubmissionID)(value)) return value
  throw new SkillMarketSecurityError("invalid-request", "submission ID is invalid")
}

function requireIdempotencyKey(value: string) {
  if (/^[\x21-\x7e]{8,200}$/.test(value)) return value
  throw new SkillMarketSecurityError("invalid-request", "idempotency key is invalid")
}

function requireActiveUser(connection: Database, principal: Principal) {
  const row = connection
    .query<{ disabled_at: number | null }, [string]>("SELECT disabled_at FROM users WHERE employee_id = ?")
    .get(principal.session.user.employeeID)
  if (row && row.disabled_at === null) return
  throw new SkillMarketSecurityError("forbidden", "employee cannot submit skills")
}

function requireUploadAllowance(connection: Database, principal: Principal, now: number) {
  const count = connection
    .query<{ count: number }, [string, number]>(
      `SELECT count(*) AS count
       FROM submission_revisions
       INNER JOIN submissions ON submissions.id = submission_revisions.submission_id
       WHERE submissions.owner_employee_id = ? AND submission_revisions.created_at >= ?`,
    )
    .get(principal.session.user.employeeID, now - DayMilliseconds)!.count
  if (count < 20) return
  throw new SkillMarketSecurityError("upload-rate-limited", "daily upload attempt limit reached")
}

function requireActiveAllowance(connection: Database, principal: Principal) {
  const count = connection
    .query<{ count: number }, [string]>(
      `SELECT count(*) AS count FROM submissions
       WHERE owner_employee_id = ? AND status IN (${ActiveStatusSql})`,
    )
    .get(principal.session.user.employeeID)!.count
  if (count < 5) return
  throw new SkillMarketSecurityError("upload-rate-limited", "active submission limit reached")
}

function requireOwnershipAndVersion(
  connection: Database,
  principal: Principal,
  target: SkillMarketControl.PublicationTarget,
  skillID: string,
  targetVersion: string,
  sourcePublicationID?: string,
) {
  if (target === "personal") {
    const prior = connection
      .query<{ target_version: string }, [string, string]>(
        `SELECT target_version FROM submissions
         WHERE owner_employee_id = ? AND skill_id = ? AND target_scope = 'personal'
           AND status IN (${ActiveStatusSql}, 'published')`,
      )
      .all(principal.session.user.employeeID, skillID)
      .map((row) => row.target_version)
    if (prior.some((version) => compareSemVer(targetVersion, version) <= 0))
      throw new SkillMarketSecurityError("submission-conflict", "personal Skill version must increase")
    return
  }
  const community = connection
    .query<
      { owner_employee_id: string; current_version: string | null },
      [string]
    >("SELECT owner_employee_id, current_version FROM community_skills WHERE skill_id = ?")
    .get(skillID)
  if (community && community.owner_employee_id !== principal.session.user.employeeID)
    throw new SkillMarketSecurityError("skill-owned-by-another-user", "Skill ID belongs to another employee")
  const liveRestricted =
    target === "groups" || target === "department"
      ? connection
          .query<
            { count: number },
            [string, string, string, string | null, string | null]
          >(
            `SELECT count(*) AS count FROM restricted_publications
             WHERE owner_employee_id = ? AND skill_id = ? AND version = ? AND status = 'published'
               AND (? IS NULL OR id != ?)`,
          )
          .get(
            principal.session.user.employeeID,
            skillID,
            targetVersion,
            sourcePublicationID ?? null,
            sourcePublicationID ?? null,
          )!.count
      : 0
  if (liveRestricted > 0)
    throw new SkillMarketSecurityError(
      "submission-conflict",
      "published restricted Skill version must use audience change",
    )
  const active = connection
    .query<{ count: number }, [string, string]>(
      `SELECT count(*) AS count FROM submissions
       WHERE skill_id = ? AND target_version = ? AND target_scope != 'personal'
         AND status IN (${ActiveStatusSql})`,
    )
    .get(skillID, targetVersion)!.count
  if (active > 0)
    throw new SkillMarketSecurityError("submission-conflict", "Skill version already has an active submission")

  const versions = connection
    .query<{ target_version: string }, [string, string]>(
      `SELECT target_version FROM submissions
       WHERE skill_id = ? AND owner_employee_id = ? AND target_scope != 'personal'
         AND status IN (${ActiveStatusSql})`,
    )
    .all(skillID, principal.session.user.employeeID)
    .map((row) => row.target_version)
  const prior = [...versions, ...(community?.current_version ? [community.current_version] : [])]
  if (prior.some((version) => compareSemVer(targetVersion, version) <= 0))
    throw new SkillMarketSecurityError(
      "submission-conflict",
      "target version must be higher than the public and active versions",
    )
}

function requireAudienceChangeAllowance(connection: Database, publicationID: string) {
  const active = connection
    .query<{ count: number }, [string]>(
      `SELECT count(*) AS count FROM submissions
       WHERE source_publication_id = ? AND status IN (${ActiveStatusSql})`,
    )
    .get(publicationID)!.count
  if (active > 0) throw new SkillMarketSecurityError("submission-conflict", "audience change is already active")
}

function compareSemVer(left: string, right: string) {
  const a = parseSemVer(left)
  const b = parseSemVer(right)
  const core = a.core.findIndex((value, index) => value !== b.core[index])
  if (core >= 0) return a.core[core] > b.core[core] ? 1 : -1
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let index = 0; index < length; index++) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

function reserveCommunitySkill(connection: Database, skillID: string, ownerEmployeeID: string, now: number) {
  const existing = connection
    .query<{ owner_employee_id: string }, [string]>("SELECT owner_employee_id FROM community_skills WHERE skill_id = ?")
    .get(skillID)
  if (existing) {
    if (existing.owner_employee_id === ownerEmployeeID) return
    throw new SkillMarketSecurityError("skill-owned-by-another-user", "Skill ID belongs to another employee")
  }
  connection.run(
    `INSERT INTO community_skills (skill_id, owner_employee_id, version, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
    [skillID, ownerEmployeeID, now, now],
  )
}

function parseSemVer(value: string) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.exec(
      value,
    )
  if (!match) throw new SkillMarketSecurityError("invalid-request", "target version is not canonical SemVer")
  return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], pre: match[4]?.split(".") ?? [] }
}

function insertRevision(
  connection: Database,
  submissionID: string,
  revision: number,
  metadata: SkillMarketControl.SubmissionMetadata,
  packageObject: SubmissionPackage,
  icon: SubmissionIcon | undefined,
  now: number,
) {
  connection.run(
    `INSERT INTO submission_revisions
      (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json,
       private_icon_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      submissionID,
      revision,
      packageObject.key,
      packageObject.sha256,
      packageObject.size,
      JSON.stringify(metadata),
      icon ? JSON.stringify(icon) : null,
      now,
    ],
  )
}

function insertAudit(
  connection: Database,
  event: {
    readonly actorEmployeeID?: string
    readonly action: string
    readonly submissionID: string
    readonly before?: object
    readonly after: object
    readonly now: number
  },
) {
  connection.run(
    `INSERT INTO audit_events
      (id, actor_employee_id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, ?, ?, 'submission', ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      event.actorEmployeeID ?? null,
      event.action,
      event.submissionID,
      event.before ? JSON.stringify(event.before) : null,
      JSON.stringify(event.after),
      `req_${randomSecret()}`,
      event.now,
    ],
  )
}

function readIdempotency(
  connection: Database,
  principal: Principal,
  route: string,
  key: string,
  requestHash: string,
  now: number,
): SkillMarketControl.AcceptedSubmission | undefined {
  connection.run(
    "DELETE FROM idempotency_keys WHERE employee_id = ? AND route = ? AND idempotency_key = ? AND expires_at <= ?",
    [principal.session.user.employeeID, route, key, now],
  )
  const row = connection
    .query<{ request_hash: string; response_json: string }, [string, string, string]>(
      `SELECT request_hash, response_json FROM idempotency_keys
       WHERE employee_id = ? AND route = ? AND idempotency_key = ?`,
    )
    .get(principal.session.user.employeeID, route, key)
  if (!row) return undefined
  if (row.request_hash !== requestHash)
    throw new SkillMarketSecurityError("submission-conflict", "idempotency key was used with another payload")
  return decodeJson(SkillMarketControl.AcceptedSubmission, row.response_json)
}

function writeIdempotency(
  connection: Database,
  principal: Principal,
  route: string,
  key: string,
  requestHash: string,
  response: SkillMarketControl.AcceptedSubmission,
  now: number,
) {
  connection.run(
    `INSERT INTO idempotency_keys
      (employee_id, route, idempotency_key, request_hash, response_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      principal.session.user.employeeID,
      route,
      key,
      requestHash,
      JSON.stringify(response),
      now,
      now + IdempotencyMilliseconds,
    ],
  )
}

function hashJson(value: object) {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
}

function artifactIdentity(packageObject: SubmissionPackage, icon: SubmissionIcon | undefined) {
  return {
    package: { sha256: packageObject.sha256, size: packageObject.size },
    ...(icon ? { icon: { sha256: icon.sha256, size: icon.size, mime: icon.mime } } : {}),
  }
}

function decodeJson<S extends Schema.Decoder<unknown>>(schema: S, value: string): S["Type"] {
  return Schema.decodeUnknownSync(schema)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value))
}

function decodeJsonOption<S extends Schema.Decoder<unknown>>(schema: S, value: string): S["Type"] | undefined {
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
  if (Option.isNone(json)) return undefined
  const decoded = Schema.decodeUnknownOption(schema)(json.value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

function timestamp(value: number) {
  return new Date(value).toISOString()
}
