import type { Database } from "bun:sqlite"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Option, Schema } from "effect"

export interface SubmissionSummaryRow {
  readonly id: string
  readonly skill_id: string
  readonly owner_employee_id: string
  readonly display_name: string
  readonly email: string | null
  readonly disabled_at: number | null
  readonly target_version: string
  readonly status: SkillMarketControl.SubmissionStatus
  readonly current_revision: number
  readonly version: number
  readonly scan_json: string | null
  readonly current_version: string | null
  readonly created_at: number
  readonly updated_at: number
}

interface RevisionRow {
  readonly revision_number: number
  readonly metadata_json: string
  readonly manifest_json: string | null
  readonly scan_json: string | null
  readonly validation_errors_json: string | null
  readonly created_at: number
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

interface AuditRow {
  readonly after_json: string | null
  readonly created_at: number
  readonly actor_employee_id: string | null
  readonly display_name: string | null
  readonly email: string | null
  readonly disabled_at: number | null
}

const AuditAfter = Schema.Struct({
  status: SkillMarketControl.SubmissionStatus,
  message: Schema.optional(Schema.String),
})

export function submissionSummarySelect() {
  return `SELECT
    submissions.id,
    submissions.skill_id,
    submissions.owner_employee_id,
    users.display_name,
    users.email,
    users.disabled_at,
    submissions.target_version,
    submissions.status,
    submissions.current_revision,
    submissions.version,
    submission_revisions.scan_json,
    community_skills.current_version,
    submissions.created_at,
    submissions.updated_at
   FROM submissions
   INNER JOIN users ON users.employee_id = submissions.owner_employee_id
   INNER JOIN submission_revisions
     ON submission_revisions.submission_id = submissions.id
    AND submission_revisions.revision_number = submissions.current_revision
   LEFT JOIN community_skills ON community_skills.skill_id = submissions.skill_id`
}

export function readSubmissionSummary(connection: Database, submissionID: string) {
  const row = connection
    .query<SubmissionSummaryRow, [string]>(`${submissionSummarySelect()} WHERE submissions.id = ?`)
    .get(submissionID)
  if (!row) return
  return toSubmissionSummary(row)
}

export function toSubmissionSummary(row: SubmissionSummaryRow) {
  const scan = row.scan_json ? decodeJsonOption(SkillMarketControl.ScanReport, row.scan_json) : undefined
  return Schema.decodeUnknownSync(SkillMarketControl.SubmissionSummary)({
    id: row.id,
    skillID: row.skill_id,
    owner: user(row),
    targetVersion: row.target_version,
    status: row.status,
    currentRevision: row.current_revision,
    version: row.version,
    risk: scan?.risk ?? "unknown",
    ...(row.current_version ? { currentPublicVersion: row.current_version } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  })
}

export function readSubmissionDetail(connection: Database, submissionID: string) {
  const summary = readSubmissionSummary(connection, submissionID)
  if (!summary) return
  const revisions = connection
    .query<RevisionRow, [string]>(
      `SELECT revision_number, metadata_json, manifest_json, scan_json, validation_errors_json, created_at
       FROM submission_revisions WHERE submission_id = ? ORDER BY revision_number`,
    )
    .all(submissionID)
    .map((revision) => ({
      number: revision.revision_number,
      metadata: decodeJson(SkillMarketControl.SubmissionMetadata, revision.metadata_json),
      ...(revision.manifest_json ? { manifest: decodeJson(SkillMarketControl.Manifest, revision.manifest_json) } : {}),
      ...(revision.scan_json
        ? { scan: redactScan(decodeJson(SkillMarketControl.ScanReport, revision.scan_json)) }
        : {}),
      validationIssues: revision.validation_errors_json
        ? decodeJson(Schema.Array(SkillMarketControl.ValidationIssue), revision.validation_errors_json)
        : [],
      createdAt: timestamp(revision.created_at),
    }))
  const reviews = connection
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
  const timeline = connection
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
  const community = connection
    .query<
      { current_version: string | null; public_status: SkillMarketControl.PublicStatus | null },
      [string]
    >("SELECT current_version, public_status FROM community_skills WHERE skill_id = ?")
    .get(summary.skillID)
  const metadata = revisions.find((revision) => revision.number === summary.currentRevision)?.metadata
  if (!metadata) throw new Error("submission current revision is missing")
  return Schema.decodeUnknownSync(SkillMarketControl.SubmissionDetail)({
    ...summary,
    metadata,
    revisions,
    reviews,
    timeline,
    ...(community?.current_version && community.public_status
      ? {
          publicSkill: {
            source: "community",
            id: summary.skillID,
            version: community.current_version,
            status: community.public_status,
          },
        }
      : {}),
  })
}

function redactScan(scan: SkillMarketControl.ScanReport) {
  const sensitive = /\bsk-[a-zA-Z0-9_-]{32,}\b|\bAKIA[0-9A-Z]{16}\b/g
  return {
    ...scan,
    reasons: scan.reasons.map((reason) => reason.replace(sensitive, "[REDACTED]")),
    evidence: scan.evidence.map((evidence) => {
      const summary = evidence.summary.replace(sensitive, "[REDACTED]")
      const path = evidence.path?.replace(sensitive, "[REDACTED]")
      return {
        ...evidence,
        summary: summary === evidence.summary ? summary : "Sensitive scan evidence redacted",
        ...(path ? { path } : {}),
      }
    }),
  }
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
