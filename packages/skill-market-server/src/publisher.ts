import type { Database } from "bun:sqlite"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { type CatalogSnapshot, mergeCatalog } from "./catalog"
import { listPublishedCommunity, materializeCommunitySubmission, publishCommunityObjects } from "./community"
import type { MarketDatabase } from "./database"
import {
  loadCurrentPointer,
  loadCurrentSnapshot,
  type PrivateObjectStore,
  publishSnapshotObjects,
  publishSnapshotPointer,
} from "./oss"
import { randomSecret } from "./security"

interface PublisherOptions {
  readonly database: MarketDatabase
  readonly store: PrivateObjectStore
  readonly ossPrefix: string
  readonly publicBaseUrl: string
  readonly webBaseUrl: string
  readonly leaseMilliseconds?: number
  readonly now?: () => number
}

interface JobRow {
  readonly id: string
  readonly submission_id: string | null
  readonly kind: "publish" | "catalog_rebuild"
  readonly status: "pending" | "running" | "failed" | "completed"
  readonly target_revision: string | null
  readonly lease_owner: string | null
  readonly lease_expires_at: number | null
  readonly skill_id: string | null
  readonly target_version: string | null
}

interface SubmissionState {
  readonly status: string
  readonly version: number
}

export class Publisher {
  constructor(private readonly options: PublisherOptions) {}

  async runOne(workerID: string) {
    requireWorkerID(workerID)
    await this.recover()
    const job = this.claim(workerID)
    if (!job) return undefined
    if (job.target_revision && (await this.pointerRevision()) === job.target_revision) {
      this.finalize(job)
      return { jobID: job.id, kind: job.kind, revision: job.target_revision }
    }

    const snapshot = job.kind === "publish" ? await this.buildPublication(job) : await this.buildRebuild()
    await publishSnapshotObjects(this.options.store, { prefix: this.options.ossPrefix }, snapshot)
    this.persistTarget(job, workerID, snapshot.revision)
    await publishSnapshotPointer(this.options.store, { prefix: this.options.ossPrefix }, snapshot)
    this.finalize({ ...job, target_revision: snapshot.revision })
    return { jobID: job.id, kind: job.kind, revision: snapshot.revision }
  }

  async recover() {
    const now = this.now()
    const jobs = this.options.database.read((connection) =>
      connection
        .query<JobRow, [number]>(
          `${jobSelect()} WHERE publish_jobs.status = 'running'
          AND publish_jobs.lease_expires_at <= ? ORDER BY publish_jobs.created_at, publish_jobs.id`,
        )
        .all(now),
    )
    if (jobs.length === 0) return 0
    const pointer = await this.pointerRevision()
    return jobs.reduce(
      (pending, job) =>
        pending.then((count) => {
          if (job.target_revision && job.target_revision === pointer) {
            this.finalize(job, true)
            return count + 1
          }
          const reset = this.options.database.transaction(
            (connection) =>
              connection.run(
                `UPDATE publish_jobs
             SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'running' AND lease_expires_at <= ?`,
                [now, job.id, now],
              ).changes,
          )
          return count + Number(reset > 0)
        }),
      Promise.resolve(0),
    )
  }

  async withCatalogLease<T>(
    workerID: string,
    operation: (publish: (snapshot: CatalogSnapshot) => Promise<void>) => Promise<T>,
  ) {
    requireWorkerID(workerID)
    const now = this.now()
    const job = this.options.database.transaction((connection) => {
      const queued = connection
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM publish_jobs WHERE status IN ('pending', 'running')")
        .get()!.count
      if (queued > 0) throw new Error("catalog publication queue must be drained before synchronization")
      const jobID = `job_${randomSecret()}`
      connection.run(
        `INSERT INTO publish_jobs
          (id, kind, status, lease_owner, lease_expires_at, attempts, created_at, updated_at)
         VALUES (?, 'catalog_rebuild', 'running', ?, ?, 1, ?, ?)`,
        [jobID, workerID, now + (this.options.leaseMilliseconds ?? 5 * 60 * 1_000), now, now],
      )
      return readJob(connection, jobID)!
    })
    const state: { revision?: string } = {}
    const value = await operation(async (snapshot) => {
      if (state.revision) throw new Error("catalog lease cannot move the pointer more than once")
      await publishSnapshotObjects(this.options.store, { prefix: this.options.ossPrefix }, snapshot)
      this.persistTarget(job, workerID, snapshot.revision)
      state.revision = snapshot.revision
      await publishSnapshotPointer(this.options.store, { prefix: this.options.ossPrefix }, snapshot)
    })
    this.finalize({ ...job, target_revision: state.revision ?? null })
    return value
  }

  private claim(workerID: string) {
    const now = this.now()
    return this.options.database.transaction((connection) => {
      const active = connection
        .query<
          { count: number },
          [number]
        >("SELECT count(*) AS count FROM publish_jobs WHERE status = 'running' AND lease_expires_at > ?")
        .get(now)!.count
      if (active > 0) return undefined
      const candidate = connection
        .query<
          { id: string },
          []
        >("SELECT id FROM publish_jobs WHERE status = 'pending' ORDER BY created_at, id LIMIT 1")
        .get()
      if (!candidate) return undefined
      connection.run(
        `UPDATE publish_jobs
         SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        [workerID, now + (this.options.leaseMilliseconds ?? 5 * 60 * 1_000), now, candidate.id],
      )
      const job = readJob(connection, candidate.id)
      if (job?.kind === "publish") insertPublishStarted(connection, job, now)
      return job
    })
  }

  private async buildPublication(job: JobRow) {
    if (!job.submission_id) throw new Error("publish job has no submission")
    await publishCommunityObjects(
      this.options.database,
      { store: this.options.store, publicPrefix: this.options.ossPrefix },
      job.submission_id,
    )
    const [base, community, candidate] = await Promise.all([
      this.baseSnapshot(),
      listPublishedCommunity(this.options.database, this.communityOptions()),
      materializeCommunitySubmission(this.options.database, this.communityOptions(), job.submission_id),
    ])
    return mergeCatalog(
      [
        ...base.details.filter((detail) => detail.source !== "community"),
        ...community.filter((detail) => detail.id !== candidate.id),
        candidate,
      ],
      emptyEnterpriseIndex(this.now()),
      { ...base.sourceStatus, community: "fresh" },
    )
  }

  private async buildRebuild() {
    const [base, community] = await Promise.all([
      this.baseSnapshot(),
      listPublishedCommunity(this.options.database, this.communityOptions()),
    ])
    return mergeCatalog(
      [...base.details.filter((detail) => detail.source !== "community"), ...community],
      emptyEnterpriseIndex(this.now()),
      { ...base.sourceStatus, community: "fresh" },
    )
  }

  private async baseSnapshot() {
    const loaded = await settled(loadCurrentSnapshot(this.options.store, { prefix: this.options.ossPrefix }))
    if (!loaded.ok)
      return {
        details: [] as SkillMarket.Detail[],
        sourceStatus: { skillhub: "unavailable", enterprise: "unavailable", community: "fresh" } as const,
      }
    return { details: Array.from(loaded.value.details.values()), sourceStatus: loaded.value.sourceStatus }
  }

  private persistTarget(job: JobRow, workerID: string, revision: string) {
    const now = this.now()
    this.options.database.transaction((connection) => {
      const updated = connection.run(
        `UPDATE publish_jobs
         SET target_revision = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        [revision, now + (this.options.leaseMilliseconds ?? 5 * 60 * 1_000), now, job.id, workerID],
      ).changes
      if (updated !== 1) throw new Error("publish job lease was lost before pointer update")
    })
  }

  private finalize(job: JobRow, expired = false) {
    const now = this.now()
    this.options.database.transaction((connection) => {
      const current = readJob(connection, job.id)
      if (!current || current.status !== "running" || current.target_revision !== job.target_revision)
        throw new Error("publish job cannot be finalized")
      if (expired && (current.lease_expires_at === null || current.lease_expires_at > now))
        throw new Error("publish job lease has not expired")
      if (current.kind === "publish") finalizeSubmission(connection, current, now)
      connection.run(
        `UPDATE publish_jobs
         SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
             error_code = NULL, error_summary = NULL, updated_at = ?
         WHERE id = ?`,
        [now, current.id],
      )
    })
  }

  private async pointerRevision() {
    const pointer = await settled(loadCurrentPointer(this.options.store, { prefix: this.options.ossPrefix }))
    return pointer.ok ? pointer.value.revision : undefined
  }

  private communityOptions() {
    return {
      store: this.options.store,
      publicPrefix: this.options.ossPrefix,
      publicBaseUrl: this.options.publicBaseUrl,
      webBaseUrl: this.options.webBaseUrl,
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }
}

export function createPublisher(options: PublisherOptions) {
  return new Publisher(options)
}

function jobSelect() {
  return `SELECT
    publish_jobs.id,
    publish_jobs.submission_id,
    publish_jobs.kind,
    publish_jobs.status,
    publish_jobs.target_revision,
    publish_jobs.lease_owner,
    publish_jobs.lease_expires_at,
    submissions.skill_id,
    submissions.target_version
   FROM publish_jobs
   LEFT JOIN submissions ON submissions.id = publish_jobs.submission_id`
}

function readJob(connection: Database, jobID: string) {
  return connection.query<JobRow, [string]>(`${jobSelect()} WHERE publish_jobs.id = ?`).get(jobID)
}

function finalizeSubmission(connection: Database, job: JobRow, now: number) {
  if (!job.submission_id || !job.skill_id || !job.target_version || !job.target_revision)
    throw new Error("publish job submission is missing")
  const submission = connection
    .query<SubmissionState, [string]>("SELECT status, version FROM submissions WHERE id = ?")
    .get(job.submission_id)
  if (!submission || submission.status !== "publishing") throw new Error("submission is not awaiting publication")
  connection.run(
    "UPDATE submissions SET status = 'published', version = version + 1, user_message = NULL, updated_at = ? WHERE id = ?",
    [now, job.submission_id],
  )
  const updated = connection.run(
    `UPDATE community_skills
     SET current_version = ?, current_submission_id = ?, public_status = 'published', delist_reason = NULL,
         version = version + 1, updated_at = ?
     WHERE skill_id = ?`,
    [job.target_version, job.submission_id, now, job.skill_id],
  ).changes
  if (updated !== 1) throw new Error("community skill reservation is missing")
  connection.run(
    `INSERT INTO audit_events
      (id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, 'publish-succeeded', 'submission', ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      job.submission_id,
      JSON.stringify({ status: submission.status, version: submission.version }),
      JSON.stringify({ status: "published", version: submission.version + 1, catalogRevision: job.target_revision }),
      `req_${randomSecret()}`,
      now,
    ],
  )
}

function insertPublishStarted(connection: Database, job: JobRow, now: number) {
  if (!job.submission_id) throw new Error("publish job submission is missing")
  const existing = connection
    .query<
      { count: number },
      [string]
    >("SELECT count(*) AS count FROM audit_events WHERE action = 'publish-started' AND object_id = ?")
    .get(job.submission_id)!.count
  if (existing > 0) return
  const submission = connection
    .query<SubmissionState, [string]>("SELECT status, version FROM submissions WHERE id = ?")
    .get(job.submission_id)
  if (!submission) throw new Error("publish job submission is missing")
  connection.run(
    `INSERT INTO audit_events
      (id, action, object_type, object_id, after_json, request_id, created_at)
     VALUES (?, 'publish-started', 'submission', ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      job.submission_id,
      JSON.stringify({ status: submission.status, version: submission.version }),
      `req_${randomSecret()}`,
      now,
    ],
  )
}

function emptyEnterpriseIndex(now: number): SkillMarket.EnterpriseIndex {
  return { schemaVersion: 1, updatedAt: new Date(now).toISOString(), skills: [] }
}

function requireWorkerID(value: string) {
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) return value
  throw new Error("publisher worker ID is invalid")
}

async function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  )
}
