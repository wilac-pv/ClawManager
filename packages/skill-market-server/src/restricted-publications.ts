import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Option, Schema } from "effect"
import type { Connection } from "./store"
import { randomSecret } from "./security"

interface RestrictedSubmissionRow {
  readonly id: string
  readonly skill_id: string
  readonly owner_employee_id: string
  readonly target_version: string
  readonly target_scope: "groups" | "department"
  readonly target_department_id: string | null
  readonly source_publication_id: string | null
  readonly status: string
  readonly current_revision: number
  readonly row_version: number
  readonly private_package_key: string
  readonly package_sha256: string
  readonly package_size: number
  readonly metadata_json: string
  readonly manifest_json: string | null
  readonly scan_json: string | null
  readonly validation_errors_json: string | null
}

interface AudienceChangeArtifactRow {
  readonly skill_id: string
  readonly owner_employee_id: string
  readonly target_version: string
  readonly source_publication_id: string | null
  readonly private_package_key: string
  readonly package_sha256: string
  readonly package_size: number
  readonly metadata_json: string
  readonly publication_skill_id: string | null
  readonly publication_owner_employee_id: string | null
  readonly publication_version: string | null
  readonly publication_package_key: string | null
  readonly publication_package_sha256: string | null
  readonly publication_package_size: number | null
  readonly publication_metadata_json: string | null
  readonly publication_status: string | null
}

export async function requireAudienceChangeArtifact(connection: Connection, submissionID: string) {
  const row = await connection.get<AudienceChangeArtifactRow>(
    `SELECT
        submissions.skill_id,
        submissions.owner_employee_id,
        submissions.target_version,
        submissions.source_publication_id,
        submission_revisions.private_package_key,
        submission_revisions.package_sha256,
        submission_revisions.package_size,
        submission_revisions.metadata_json,
        restricted_publications.skill_id AS publication_skill_id,
        restricted_publications.owner_employee_id AS publication_owner_employee_id,
        restricted_publications.version AS publication_version,
        restricted_publications.package_key AS publication_package_key,
        restricted_publications.package_sha256 AS publication_package_sha256,
        restricted_publications.package_size AS publication_package_size,
        restricted_publications.metadata_json AS publication_metadata_json,
        restricted_publications.status AS publication_status
       FROM submissions
       INNER JOIN submission_revisions
         ON submission_revisions.submission_id = submissions.id
        AND submission_revisions.revision_number = submissions.current_revision
       LEFT JOIN restricted_publications ON restricted_publications.id = submissions.source_publication_id
       WHERE submissions.id = ?`,
    [submissionID],
  )
  if (!row) throw new Error("audience change submission is missing")
  if (!row.source_publication_id) return
  if (
    row.publication_status !== "published" ||
    row.publication_skill_id !== row.skill_id ||
    row.publication_owner_employee_id !== row.owner_employee_id ||
    row.publication_version !== row.target_version
  )
    throw new Error("audience change source publication no longer matches")
  if (
    row.publication_package_key !== row.private_package_key ||
    row.publication_package_sha256 !== row.package_sha256 ||
    row.publication_package_size !== row.package_size ||
    row.publication_metadata_json !== row.metadata_json
  )
    throw new Error("audience change cannot alter the reviewed artifact")
}

export async function publishRestrictedSubmission(connection: Connection, submissionID: string, now: number) {
  const submission = await connection.get<RestrictedSubmissionRow>(
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
        submissions.version AS row_version,
        submission_revisions.private_package_key,
        submission_revisions.package_sha256,
        submission_revisions.package_size,
        submission_revisions.metadata_json,
        submission_revisions.manifest_json,
        submission_revisions.scan_json,
        submission_revisions.validation_errors_json
       FROM submissions
       INNER JOIN submission_revisions
         ON submission_revisions.submission_id = submissions.id
        AND submission_revisions.revision_number = submissions.current_revision
       WHERE submissions.id = ?
         AND submissions.target_scope IN ('groups', 'department')`,
    [submissionID],
  )
  if (!submission || submission.status !== "publishing")
    throw new Error("restricted submission is not awaiting publication")
  if (
    !submission.manifest_json ||
    !submission.scan_json ||
    !submission.validation_errors_json ||
    decodeValidationIssues(submission.validation_errors_json).length !== 0
  )
    throw new Error("restricted submission revision is not verified")
  await requireApprovedRevision(connection, submission.id, submission.current_revision)
  if (!submission.source_publication_id) await requireApprovedArtifact(connection, submission)
  await requireAudienceChangeArtifact(connection, submission.id)
  if (submission.private_package_key.includes("://"))
    throw new Error("restricted submission package must remain in private storage")

  const publication = submission.source_publication_id
    ? await connection.get<{
        id: string
        skill_id: string
        owner_employee_id: string
        version: string
        status: string
        row_version: number
      }>(
        `SELECT id, skill_id, owner_employee_id, version, status, row_version
           FROM restricted_publications WHERE id = ?`,
        [submission.source_publication_id],
      )
    : undefined
  if (
    submission.source_publication_id &&
    (!publication ||
      publication.status !== "published" ||
      publication.skill_id !== submission.skill_id ||
      publication.owner_employee_id !== submission.owner_employee_id ||
      publication.version !== submission.target_version)
  )
    throw new Error("audience change source publication no longer matches")

  const publicationID = publication?.id ?? `pub_${randomSecret()}`
  const publicationVersion = publication ? publication.row_version + 1 : 1
  if (publication) {
    await connection.run(
      `UPDATE restricted_publications
       SET submission_id = ?, scope = ?, department_id = ?, package_key = ?, package_sha256 = ?,
           package_size = ?, metadata_json = ?, status = 'published', row_version = ?, updated_at = ?
       WHERE id = ?`,
      [
        submission.id,
        submission.target_scope,
        submission.target_department_id,
        submission.private_package_key,
        submission.package_sha256,
        submission.package_size,
        submission.metadata_json,
        publicationVersion,
        now,
        publicationID,
      ],
    )
    await connection.run("DELETE FROM restricted_publication_groups WHERE publication_id = ?", [publicationID])
  }
  if (!publication)
    await connection.run(
      `INSERT INTO restricted_publications
        (id, submission_id, skill_id, owner_employee_id, version, scope, department_id, package_key,
         package_sha256, package_size, metadata_json, status, row_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 1, ?, ?)`,
      [
        publicationID,
        submission.id,
        submission.skill_id,
        submission.owner_employee_id,
        submission.target_version,
        submission.target_scope,
        submission.target_department_id,
        submission.private_package_key,
        submission.package_sha256,
        submission.package_size,
        submission.metadata_json,
        now,
        now,
      ],
    )
  if (submission.target_scope === "groups")
    await connection.run(
      `INSERT INTO restricted_publication_groups (publication_id, group_id)
       SELECT ?, submission_group_targets.group_id
       FROM submission_group_targets
       WHERE submission_group_targets.submission_id = ?`,
      [publicationID, submission.id],
    )
  const groupCount = (
    await connection.get<{ count: number }>(
      "SELECT count(*) AS count FROM restricted_publication_groups WHERE publication_id = ?",
      [publicationID],
    )
  )?.count
  if (submission.target_scope === "groups" && (groupCount ?? 0) < 1)
    throw new Error("restricted group publication has no reviewed targets")
  if (submission.target_scope === "department" && groupCount !== 0)
    throw new Error("restricted department publication has group targets")

  await connection.run(
    "UPDATE submissions SET status = 'published', version = version + 1, user_message = NULL, updated_at = ? WHERE id = ?",
    [now, submission.id],
  )
  await connection.run(
    `INSERT INTO audit_events
      (id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, 'publish-succeeded', 'submission', ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      submission.id,
      JSON.stringify({ status: submission.status, version: submission.row_version }),
      JSON.stringify({
        status: "published",
        version: submission.row_version + 1,
        publicationID,
        publicationVersion,
      }),
      `req_${randomSecret()}`,
      now,
    ],
  )
  return { publicationID, publicationVersion }
}

export async function publishPersonalAudienceChange(connection: Connection, submissionID: string, now: number) {
  const submission = await connection.get<{
    id: string
    skill_id: string
    owner_employee_id: string
    target_version: string
    source_publication_id: string | null
    status: string
    current_revision: number
    row_version: number
    manifest_json: string | null
    scan_json: string | null
    validation_errors_json: string | null
  }>(
    `SELECT
        submissions.id,
        submissions.skill_id,
        submissions.owner_employee_id,
        submissions.target_version,
        submissions.source_publication_id,
        submissions.status,
        submissions.current_revision,
        submissions.version AS row_version,
        submission_revisions.manifest_json,
        submission_revisions.scan_json,
        submission_revisions.validation_errors_json
       FROM submissions
       INNER JOIN submission_revisions
         ON submission_revisions.submission_id = submissions.id
        AND submission_revisions.revision_number = submissions.current_revision
       WHERE submissions.id = ? AND submissions.target_scope = 'personal'`,
    [submissionID],
  )
  if (
    !submission ||
    submission.status !== "publishing" ||
    !submission.source_publication_id ||
    !submission.manifest_json ||
    !submission.scan_json ||
    !submission.validation_errors_json ||
    decodeValidationIssues(submission.validation_errors_json).length !== 0
  )
    throw new Error("personal audience change is not verified for publication")
  await requireApprovedRevision(connection, submission.id, submission.current_revision)
  await requireAudienceChangeArtifact(connection, submission.id)
  const publication = await connection.get<{
    skill_id: string
    owner_employee_id: string
    version: string
    status: string
    row_version: number
  }>(
    `SELECT skill_id, owner_employee_id, version, status, row_version
       FROM restricted_publications WHERE id = ?`,
    [submission.source_publication_id],
  )
  if (
    !publication ||
    publication.status !== "published" ||
    publication.skill_id !== submission.skill_id ||
    publication.owner_employee_id !== submission.owner_employee_id ||
    publication.version !== submission.target_version
  )
    throw new Error("personal audience change source publication no longer matches")

  await connection.run(
    "UPDATE submissions SET status = 'published', version = version + 1, user_message = NULL, updated_at = ? WHERE id = ?",
    [now, submission.id],
  )
  await connection.run(
    `UPDATE restricted_publications
     SET status = 'delisted', row_version = row_version + 1, updated_at = ?
     WHERE id = ?`,
    [now, submission.source_publication_id],
  )
  await connection.run(
    `INSERT INTO audit_events
      (id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, 'publish-succeeded', 'submission', ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      submission.id,
      JSON.stringify({ status: submission.status, version: submission.row_version }),
      JSON.stringify({
        status: "published",
        version: submission.row_version + 1,
        replacedPublicationID: submission.source_publication_id,
        publicationVersion: publication.row_version + 1,
      }),
      `req_${randomSecret()}`,
      now,
    ],
  )
  return {
    publicationID: submission.source_publication_id,
    publicationVersion: publication.row_version + 1,
  }
}

function decodeValidationIssues(value: string) {
  return Schema.decodeUnknownSync(Schema.Array(SkillMarketControl.ValidationIssue))(
    Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(value),
  )
}

async function requireApprovedRevision(connection: Connection, submissionID: string, revision: number) {
  const approved = (
    await connection.get<{ count: number }>(
      `SELECT count(*) AS count FROM reviews
       WHERE submission_id = ? AND revision_number = ? AND decision = 'approve'`,
      [submissionID, revision],
    )
  )?.count
  if ((approved ?? 0) < 1) throw new Error("restricted submission is not approved")
}

async function requireApprovedArtifact(connection: Connection, submission: RestrictedSubmissionRow) {
  const approved = (
    await connection.get<{ count: number }>(
      `SELECT count(*) AS count FROM reviews
       WHERE submission_id = ? AND revision_number = ? AND decision = 'approve'
         AND approved_package_key = ?
         AND approved_package_sha256 = ?
         AND approved_package_size = ?
         AND approved_metadata_json = ?`,
      [
        submission.id,
        submission.current_revision,
        submission.private_package_key,
        submission.package_sha256,
        submission.package_size,
        submission.metadata_json,
      ],
    )
  )?.count
  if ((approved ?? 0) < 1) throw new Error("restricted submission approved artifact identity no longer matches")

  const json = submission.manifest_json
    ? Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(submission.manifest_json)
    : Option.none()
  const manifest = Option.isSome(json)
    ? Schema.decodeUnknownOption(SkillMarketControl.Manifest)(json.value)
    : Option.none()
  if (
    Option.isNone(manifest) ||
    manifest.value.packageSha256 !== submission.package_sha256 ||
    manifest.value.packageSize !== submission.package_size
  )
    throw new Error("restricted submission validated manifest no longer matches")
}
