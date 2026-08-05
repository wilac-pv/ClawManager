import type { Database } from "bun:sqlite"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import type { Principal } from "./security"
import { randomSecret, SkillMarketSecurityError } from "./security"

const WithdrawableStatusSql =
  "'validating', 'validation_failed', 'pending_review', 'changes_requested', 'publish_failed'"

export function requireLifecycleFence(
  connection: Database,
  input: {
    readonly submissionID: string
    readonly revision: number
    readonly status: string
    readonly version: number
    readonly leaseOwner: string
  },
) {
  const claimed = connection
    .query<{ claimed: number }, [number, string, string, number, string]>(
      `SELECT 1 AS claimed
       FROM submissions
       INNER JOIN submission_revisions
         ON submission_revisions.submission_id = submissions.id
        AND submission_revisions.revision_number = ?
       WHERE submissions.id = ?
         AND submissions.current_revision = submission_revisions.revision_number
         AND submissions.status = ?
         AND submissions.version = ?
         AND submission_revisions.validation_lease_owner = ?`,
    )
    .get(input.revision, input.submissionID, input.status, input.version, input.leaseOwner)
  if (claimed) return
  throw new SkillMarketSecurityError("submission-conflict", "submission lifecycle claim is stale")
}

export function withdraw(
  connection: Database,
  principal: Principal,
  submissionID: string,
  expectedVersion: number,
  now: number,
) {
  const submission = connection
    .query<{ status: string; version: number }, [string, string]>(
      "SELECT status, version FROM submissions WHERE id = ? AND owner_employee_id = ? AND deleted_at IS NULL",
    )
    .get(submissionID, principal.session.user.employeeID)
  if (!submission) throw new SkillMarketSecurityError("not-found", "submission was not found")
  if (submission.version !== expectedVersion)
    throw new SkillMarketSecurityError("submission-conflict", "submission version no longer matches")

  const result = connection.run(
    `UPDATE submissions
     SET status = 'withdrawn', version = version + 1, user_message = NULL, updated_at = ?
     WHERE id = ? AND owner_employee_id = ? AND version = ? AND status IN (${WithdrawableStatusSql})`,
    [now, submissionID, principal.session.user.employeeID, expectedVersion],
  )
  if (result.changes !== 1)
    throw new SkillMarketSecurityError("submission-conflict", "submission cannot be withdrawn")

  connection.run(
    `UPDATE submission_revisions
     SET validation_lease_owner = NULL, validation_lease_expires_at = NULL
     WHERE submission_id = ?`,
    [submissionID],
  )
  connection.run(
    `UPDATE publish_jobs
     SET status = CASE WHEN status = 'running' THEN 'failed' ELSE status END,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE submission_id = ? AND lease_owner IS NOT NULL`,
    [now, submissionID],
  )
  connection.run(
    `INSERT INTO audit_events
      (id, actor_employee_id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, ?, 'submission-withdrawn', 'submission', ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      principal.session.user.employeeID,
      submissionID,
      JSON.stringify({ status: submission.status, version: submission.version }),
      JSON.stringify({ status: "withdrawn", version: submission.version + 1 }),
      `req_${randomSecret()}`,
      now,
    ],
  )
}

export function requestDelist(
  connection: Database,
  principal: Principal,
  submissionID: string,
  expectedVersion: number,
  reason: string,
  now: number,
) {
  const submission = connection
    .query<
      { target_scope: SkillMarketControl.PublicationTarget; status: string; version: number },
      [string, string]
    >(
      `SELECT target_scope, status, version
       FROM submissions
       WHERE id = ? AND owner_employee_id = ? AND deleted_at IS NULL`,
    )
    .get(submissionID, principal.session.user.employeeID)
  if (!submission) throw new SkillMarketSecurityError("not-found", "submission was not found")
  if (submission.status !== "published" || submission.version !== expectedVersion)
    throw new SkillMarketSecurityError("submission-conflict", "submission is not the current published version")

  const live =
    submission.target_scope === "company"
      ? connection
          .query<{ live: number }, [string]>(
            `SELECT 1 AS live FROM community_skills
             WHERE current_submission_id = ? AND public_status = 'published'`,
          )
          .get(submissionID)
      : submission.target_scope === "personal"
        ? { live: 1 }
        : connection
            .query<{ live: number }, [string]>(
              "SELECT 1 AS live FROM restricted_publications WHERE submission_id = ? AND status = 'published'",
            )
            .get(submissionID)
  if (!live) throw new SkillMarketSecurityError("submission-conflict", "submission is not currently published")
  if (
    connection
      .query<{ pending: number }, [string]>(
        "SELECT 1 AS pending FROM delist_requests WHERE submission_id = ? AND status = 'pending'",
      )
      .get(submissionID)
  )
    throw new SkillMarketSecurityError("submission-conflict", "a delist request is already pending")

  const id = `dlr_${randomSecret()}`
  const inserted = connection.run(
    `INSERT INTO delist_requests
      (id, submission_id, requested_by_employee_id, reason, status, version, created_at)
     VALUES (?, ?, ?, ?, 'pending', 1, ?)
     ON CONFLICT(submission_id) WHERE status = 'pending' DO NOTHING`,
    [id, submissionID, principal.session.user.employeeID, reason, now],
  ).changes
  if (inserted !== 1)
    throw new SkillMarketSecurityError("submission-conflict", "a delist request is already pending")
  connection.run(
    `INSERT INTO audit_events
      (id, actor_employee_id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, ?, 'delist-requested', 'delist_request', ?, NULL, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      principal.session.user.employeeID,
      id,
      JSON.stringify({ status: "pending", version: 1, submissionID }),
      `req_${randomSecret()}`,
      now,
    ],
  )
  return Schema.decodeUnknownSync(SkillMarketControl.DelistRequest)({
    id,
    submissionID,
    requestedByEmployeeID: principal.session.user.employeeID,
    reason,
    status: "pending",
    version: 1,
    createdAt: new Date(now).toISOString(),
  })
}

export function decideDelist(
  connection: Database,
  principal: Principal,
  requestID: string,
  expectedVersion: number,
  decision: "approved" | "rejected",
  now: number,
) {
  const request = connection
    .query<
      {
        id: string
        submission_id: string
        requested_by_employee_id: string
        reason: string
        status: string
        version: number
        created_at: number
        target_scope: SkillMarketControl.PublicationTarget
        submission_status: SkillMarketControl.SubmissionStatus
      },
      [string]
    >(
      `SELECT
        delist_requests.id,
        delist_requests.submission_id,
        delist_requests.requested_by_employee_id,
        delist_requests.reason,
        delist_requests.status,
        delist_requests.version,
        delist_requests.created_at,
        submissions.target_scope,
        submissions.status AS submission_status
       FROM delist_requests
       INNER JOIN submissions ON submissions.id = delist_requests.submission_id
       WHERE delist_requests.id = ?`,
    )
    .get(requestID)
  if (!request) throw new SkillMarketSecurityError("not-found", "delist request was not found")
  if (request.status !== "pending" || request.version !== expectedVersion)
    throw new SkillMarketSecurityError("submission-conflict", "delist request version no longer matches")

  if (decision === "approved") {
    if (request.submission_status !== "published")
      throw new SkillMarketSecurityError("submission-conflict", "submission is no longer published")
    const hidden =
      request.target_scope === "company"
        ? connection.run(
            `UPDATE community_skills
             SET public_status = 'delisted', delist_reason = ?, version = version + 1, updated_at = ?
             WHERE current_submission_id = ? AND public_status = 'published'`,
            [request.reason, now, request.submission_id],
          ).changes
        : request.target_scope === "personal"
          ? 1
          : connection.run(
              `UPDATE restricted_publications
               SET status = 'delisted', row_version = row_version + 1, updated_at = ?
               WHERE submission_id = ? AND status = 'published'`,
              [now, request.submission_id],
            ).changes
    if (hidden !== 1)
      throw new SkillMarketSecurityError("submission-conflict", "publication is no longer visible")
    if (request.target_scope === "company") enqueueCatalogRebuild(connection, now)
    connection.run(
      `INSERT INTO artifact_cleanup_jobs
        (id, delist_request_id, submission_id, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
      [`clean_${randomSecret()}`, requestID, request.submission_id, now, now],
    )
  }

  const decided = connection.run(
    `UPDATE delist_requests
     SET status = ?, version = version + 1, decided_by_employee_id = ?, decided_at = ?
     WHERE id = ? AND status = 'pending' AND version = ?`,
    [decision, principal.session.user.employeeID, now, requestID, expectedVersion],
  ).changes
  if (decided !== 1)
    throw new SkillMarketSecurityError("submission-conflict", "delist request version no longer matches")
  connection.run(
    `INSERT INTO audit_events
      (id, actor_employee_id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, ?, ?, 'delist_request', ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      principal.session.user.employeeID,
      decision === "approved" ? "delist-approved" : "delist-rejected",
      requestID,
      JSON.stringify({ status: "pending", version: request.version }),
      JSON.stringify({ status: decision, version: request.version + 1, submissionID: request.submission_id }),
      `req_${randomSecret()}`,
      now,
    ],
  )
  return Schema.decodeUnknownSync(SkillMarketControl.DelistRequest)({
    id: request.id,
    submissionID: request.submission_id,
    requestedByEmployeeID: request.requested_by_employee_id,
    reason: request.reason,
    status: decision,
    version: request.version + 1,
    createdAt: new Date(request.created_at).toISOString(),
    decidedByEmployeeID: principal.session.user.employeeID,
    decidedAt: new Date(now).toISOString(),
  })
}

function enqueueCatalogRebuild(connection: Database, now: number) {
  const pending = connection
    .query<{ pending: number }, []>(
      "SELECT 1 AS pending FROM publish_jobs WHERE kind = 'catalog_rebuild' AND status = 'pending' LIMIT 1",
    )
    .get()
  if (pending) return
  connection.run(
    `INSERT INTO publish_jobs (id, kind, status, attempts, created_at, updated_at)
     VALUES (?, 'catalog_rebuild', 'pending', 0, ?, ?)`,
    [`job_${randomSecret()}`, now, now],
  )
}
