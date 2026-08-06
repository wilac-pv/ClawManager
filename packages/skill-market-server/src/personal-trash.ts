import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Option, Schema } from "effect"
import type { Connection, MarketDatabase } from "./store"
import type { PrivateObjectStore } from "./oss"
import type { Principal } from "./security"
import { randomSecret, SkillMarketSecurityError } from "./security"
import {
  type SubmissionSummaryRow,
  submissionSummarySelect,
  toSubmissionSummary,
} from "./submission-read"

const WeekMilliseconds = 7 * 24 * 60 * 60_000
const PurgeLeaseMilliseconds = 5 * 60_000

export interface PersonalTrashOptions {
  readonly database: MarketDatabase
  readonly store?: Pick<PrivateObjectStore, "delete">
  readonly now?: () => number
}

interface PersonalRow {
  readonly id: string
  readonly owner_employee_id: string
  readonly target_scope: SkillMarketControl.PublicationTarget
  readonly status: SkillMarketControl.SubmissionStatus
  readonly version: number
  readonly deleted_at: number | null
  readonly purge_after: number | null
  readonly artifacts_purge_token: string | null
  readonly artifacts_purge_claimed_at: number | null
  readonly artifacts_purged_at: number | null
}

interface ArtifactRow {
  readonly revision_number: number
  readonly private_package_key: string
  readonly private_icon_json: string | null
}

const PrivateIcon = Schema.Struct({ key: Schema.String })

export class PersonalTrash {
  constructor(private readonly options: PersonalTrashOptions) {}

  list(principal: Principal) {
    return this.options.database.read(async (connection) =>
      (
        await connection.all<SubmissionSummaryRow & { deleted_at: number; purge_after: number }>(
          `${submissionSummarySelect(", submissions.deleted_at, submissions.purge_after")}
         WHERE submissions.owner_employee_id = ?
           AND submissions.target_scope = 'personal'
           AND submissions.deleted_at IS NOT NULL
           AND submissions.purge_after IS NOT NULL
         ORDER BY submissions.deleted_at DESC, submissions.id DESC`,
          [principal.session.user.employeeID],
        )
      ).map((row) =>
        Schema.decodeUnknownSync(SkillMarketControl.PersonalTrashItem)({
          ...toSubmissionSummary(row),
          deletedAt: timestamp(row.deleted_at),
          purgeAfter: timestamp(row.purge_after),
        }),
      ),
    )
  }

  deletePersonal(principal: Principal, submissionID: string, expectedVersion: number) {
    const now = this.options.now?.() ?? Date.now()
    return this.options.database.transaction(async (connection) => {
      const row = await personalRow(connection, submissionID, principal.session.user.employeeID)
      if (!row || row.target_scope !== "personal" || row.status !== "published" || row.deleted_at !== null)
        throw new SkillMarketSecurityError("not-found", "personal Skill was not found")
      if (row.version !== expectedVersion)
        throw new SkillMarketSecurityError("submission-conflict", "submission version no longer matches")
      const purgeAfter = now + WeekMilliseconds
      const updated = await connection.run(
        `UPDATE submissions
         SET deleted_at = ?, purge_after = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND owner_employee_id = ? AND target_scope = 'personal' AND status = 'published'
           AND deleted_at IS NULL AND version = ?`,
        [now, purgeAfter, now, submissionID, principal.session.user.employeeID, expectedVersion],
      )
      if (updated !== 1) throw new SkillMarketSecurityError("submission-conflict", "submission version no longer matches")
      await insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "personal-deleted",
        submissionID,
        before: { status: row.status, version: row.version },
        after: { status: row.status, version: row.version + 1, deletedAt: timestamp(now), purgeAfter: timestamp(purgeAfter) },
        now,
      })
      return trashItem(connection, submissionID)
    })
  }

  restorePersonal(principal: Principal, submissionID: string, expectedVersion: number) {
    const now = this.options.now?.() ?? Date.now()
    return this.options.database.transaction(async (connection) => {
      const row = await personalRow(connection, submissionID, principal.session.user.employeeID)
      if (
        !row ||
        row.target_scope !== "personal" ||
        row.status !== "published" ||
        row.deleted_at === null ||
        row.purge_after === null ||
        now >= row.purge_after ||
        row.artifacts_purged_at !== null
      )
        throw new SkillMarketSecurityError("not-found", "personal Skill was not found")
      if (row.version !== expectedVersion)
        throw new SkillMarketSecurityError("submission-conflict", "submission version no longer matches")
      const updated = await connection.run(
        `UPDATE submissions
         SET deleted_at = NULL, purge_after = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND owner_employee_id = ? AND target_scope = 'personal' AND status = 'published'
           AND deleted_at IS NOT NULL AND purge_after > ? AND artifacts_purged_at IS NULL AND version = ?`,
        [now, submissionID, principal.session.user.employeeID, now, expectedVersion],
      )
      if (updated !== 1) throw new SkillMarketSecurityError("submission-conflict", "submission version no longer matches")
      await insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "personal-restored",
        submissionID,
        before: { status: row.status, version: row.version, deletedAt: timestamp(row.deleted_at), purgeAfter: timestamp(row.purge_after) },
        after: { status: row.status, version: row.version + 1 },
        now,
      })
      const restored = await connection.get<SubmissionSummaryRow>(
        `${submissionSummarySelect()} WHERE submissions.id = ?`,
        [submissionID],
      )
      if (!restored) throw new Error("restored personal Skill summary is missing")
      return toSubmissionSummary(restored)
    })
  }

  async purgeExpiredPersonal() {
    const store = this.options.store
    if (!store) throw new Error("personal trash purge requires an object store")
    const now = this.options.now?.() ?? Date.now()
    const candidates = await this.options.database.read((connection) =>
      connection.all<PersonalRow>(
        `SELECT id, owner_employee_id, target_scope, status, version, deleted_at, purge_after,
                artifacts_purge_token, artifacts_purge_claimed_at, artifacts_purged_at
         FROM submissions
         WHERE target_scope = 'personal' AND deleted_at IS NOT NULL AND purge_after <= ? AND artifacts_purged_at IS NULL
           AND (artifacts_purge_token IS NULL OR artifacts_purge_claimed_at <= ?)
         ORDER BY purge_after, id`,
        [now, now - PurgeLeaseMilliseconds],
      ),
    )
    const purged: string[] = []
    for (const candidate of candidates) {
      if (candidate.deleted_at === null || candidate.purge_after === null) continue
      const token = randomSecret()
      const claimed = await this.options.database.transaction(
        async (connection) =>
          (await connection.run(
            `UPDATE submissions SET artifacts_purge_token = ?, artifacts_purge_claimed_at = ?
             WHERE id = ? AND version = ? AND deleted_at = ? AND purge_after = ? AND purge_after <= ?
               AND artifacts_purged_at IS NULL
               AND (artifacts_purge_token IS NULL OR artifacts_purge_claimed_at <= ?)`,
            [
              token,
              now,
              candidate.id,
              candidate.version,
              candidate.deleted_at,
              candidate.purge_after,
              now,
              now - PurgeLeaseMilliseconds,
            ],
          )) === 1,
      )
      if (!claimed) continue
      const artifacts = await this.options.database.read((connection) =>
        connection.all<ArtifactRow>(
          `SELECT revision_number, private_package_key, private_icon_json
           FROM submission_revisions WHERE submission_id = ? ORDER BY revision_number`,
          [candidate.id],
        ),
      )
      const families = artifacts.flatMap((artifact) => {
        const directory = artifact.private_package_key.replace(/[^/]+$/, "")
        const icon = artifact.private_icon_json
          ? Schema.decodeUnknownOption(PrivateIcon)(
              Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(artifact.private_icon_json),
            )
          : Option.none()
        return [
          {
            referenceKey: artifact.private_package_key,
            keys: [artifact.private_package_key, `${directory}manifest.json`, `${directory}scan.json`],
          },
          ...(Option.isSome(icon) ? [{ referenceKey: icon.value.key, keys: [icon.value.key] }] : []),
        ]
      })
      const referencedResults = await this.options.database.read((connection) =>
        Promise.all(
          families.map(async (family) => [
            family,
            await referenced(connection, candidate.id, family.referenceKey),
          ] as const),
        ),
      )
      const unique = [
        ...new Set(
          referencedResults.flatMap(([family, isReferenced]) =>
            isReferenced ? [] : family.keys,
          ),
        ),
      ]
      try {
        await Promise.all(unique.map((key) => store.delete(key)))
      } catch (error) {
        await this.options.database.transaction((connection) =>
          connection.run(
            `UPDATE submissions SET artifacts_purge_token = NULL, artifacts_purge_claimed_at = NULL
             WHERE id = ? AND artifacts_purge_token = ? AND artifacts_purged_at IS NULL`,
            [candidate.id, token],
          ),
        )
        throw error
      }
      const completed = await this.options.database.transaction(async (connection) => {
        const current = await personalRow(connection, candidate.id)
        if (
          !current ||
          current.version !== candidate.version ||
          current.deleted_at !== candidate.deleted_at ||
          current.purge_after !== candidate.purge_after ||
          current.purge_after === null ||
          current.purge_after > now ||
          current.artifacts_purge_token !== token ||
          current.artifacts_purged_at !== null
        )
          return false
        return (
          (await connection.run(
            `UPDATE submissions
             SET artifacts_purge_token = NULL, artifacts_purge_claimed_at = NULL, artifacts_purged_at = ?
             WHERE id = ? AND version = ? AND deleted_at = ? AND purge_after = ?
               AND artifacts_purge_token = ? AND artifacts_purged_at IS NULL`,
            [now, candidate.id, candidate.version, candidate.deleted_at, candidate.purge_after, token],
          )) === 1
        )
      })
      if (completed) purged.push(candidate.id)
    }
    return { purged }
  }
}

export function createPersonalTrash(options: PersonalTrashOptions) {
  return new PersonalTrash(options)
}

async function personalRow(connection: Connection, submissionID: string, employeeID?: string) {
  if (employeeID)
    return connection.get<PersonalRow>(
      `SELECT id, owner_employee_id, target_scope, status, version, deleted_at, purge_after,
                artifacts_purge_token, artifacts_purge_claimed_at, artifacts_purged_at
         FROM submissions WHERE id = ? AND owner_employee_id = ?`,
      [submissionID, employeeID],
    )
  return connection.get<PersonalRow>(
    `SELECT id, owner_employee_id, target_scope, status, version, deleted_at, purge_after,
              artifacts_purge_token, artifacts_purge_claimed_at, artifacts_purged_at
       FROM submissions WHERE id = ?`,
    [submissionID],
  )
}

async function trashItem(connection: Connection, submissionID: string) {
  const row = await connection.get<SubmissionSummaryRow & { deleted_at: number; purge_after: number }>(
    `${submissionSummarySelect(", submissions.deleted_at, submissions.purge_after")} WHERE submissions.id = ?`,
    [submissionID],
  )
  if (!row) throw new Error("personal trash item is missing")
  return Schema.decodeUnknownSync(SkillMarketControl.PersonalTrashItem)({
    ...toSubmissionSummary(row),
    deletedAt: timestamp(row.deleted_at),
    purgeAfter: timestamp(row.purge_after),
  })
}

async function referenced(connection: Connection, submissionID: string, key: string) {
  const revisions = (
    await connection.get<{ count: number }>(
      `SELECT count(*) AS count FROM submission_revisions
       WHERE submission_id != ? AND (private_package_key = ? OR json_extract(private_icon_json, '$.key') = ?)`,
      [submissionID, key, key],
    )
  )?.count ?? 0
  const publications = (
    await connection.get<{ count: number }>(
      "SELECT count(*) AS count FROM restricted_publications WHERE package_key = ?",
      [key],
    )
  )?.count ?? 0
  return revisions > 0 || publications > 0
}

async function insertAudit(
  connection: Connection,
  event: {
    readonly actorEmployeeID: string
    readonly action: "personal-deleted" | "personal-restored"
    readonly submissionID: string
    readonly before: object
    readonly after: object
    readonly now: number
  },
) {
  await connection.run(
    `INSERT INTO audit_events
      (id, actor_employee_id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, ?, ?, 'submission', ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      event.actorEmployeeID,
      event.action,
      event.submissionID,
      JSON.stringify(event.before),
      JSON.stringify(event.after),
      `req_${randomSecret()}`,
      event.now,
    ],
  )
}

function timestamp(value: number) {
  return new Date(value).toISOString()
}
