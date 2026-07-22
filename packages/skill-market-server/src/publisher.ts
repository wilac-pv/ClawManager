import type { Database } from "bun:sqlite"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import {
  contentAddressDetail,
  createCatalogIndex,
  patchCatalogIndex,
  type CatalogDetailRef,
  type CatalogIndex,
  key,
} from "./catalog"
import { listPublishedCommunity, materializeCommunitySubmission, publishCommunityObjects } from "./community"
import type { MarketDatabase } from "./database"
import {
  loadCatalogDetail,
  loadCatalogIndex,
  loadCurrentPointer,
  loadCurrentSnapshot,
  isMissingObjectError,
  loadCatalogIndexOrMissingPointer,
  prepareCatalogDelta,
  type CatalogDelta,
  type PrivateObjectStore,
  publishCatalogDeltaObjects,
  publishCatalogIndexObjects,
  publishCatalogIndexPointer,
} from "./oss"
import { randomSecret } from "./security"
import type {
  CompletedSkillHubEvaluation,
  EvaluatedSkillHubEntry,
  SkillHubImportStore,
} from "./skillhub-import-store"

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
  readonly error_code: string | null
  readonly error_summary: string | null
  readonly skill_id: string | null
  readonly target_version: string | null
}

interface SubmissionState {
  readonly status: string
  readonly version: number
}

type Publication = {
  readonly index: CatalogIndex
  readonly changedDetails: ReadonlyMap<string, SkillMarket.Detail>
}

type CatalogLeasePublication = Publication | {
  readonly delta: CatalogDelta
  readonly changedDetails: ReadonlyMap<string, SkillMarket.Detail>
}

export class Publisher {
  private readonly preparations = new Map<string, Promise<{ readonly jobID: string; readonly candidate: SkillMarket.Detail }>>()

  constructor(private readonly options: PublisherOptions) {}

  async runOne(workerID: string) {
    requireWorkerID(workerID)
    await this.recover()
    const pending = this.pending()
    const prepared = pending?.kind === "publish" ? await this.preparePublication(pending) : undefined
    const job = this.claim(workerID, pending?.id)
    if (!job) return undefined
    if (prepared && prepared.jobID !== job.id) return undefined
    if (job.target_revision && (await this.pointerRevision()) === job.target_revision) {
      this.finalize(job)
      return { jobID: job.id, kind: job.kind, revision: job.target_revision }
    }

    const publication = job.kind === "publish" ? await this.buildPublication(job, prepared) : await this.buildRebuild()
    await publishCatalogIndexObjects(this.options.store, { prefix: this.options.ossPrefix }, publication.index, publication.changedDetails)
    this.persistTarget(job, workerID, publication.index.revision)
    await publishCatalogIndexPointer(this.options.store, { prefix: this.options.ossPrefix }, publication.index)
    this.finalize({ ...job, target_revision: publication.index.revision })
    return { jobID: job.id, kind: job.kind, revision: publication.index.revision }
  }

  async recover(store = this.options.store) {
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
    const pointer = await this.pointerRevision(store)
    return jobs.reduce(
      (pending, job) =>
        pending.then((count) => {
          if (job.target_revision && job.target_revision === pointer) {
            this.finalize(job, true)
            return count + 1
          }
          if (job.error_code === "catalog-delta") {
            const retired = this.options.database.transaction(
              (connection) =>
                connection.run(
                  `UPDATE publish_jobs
                   SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                       error_code = 'catalog-delta', error_summary = 'TRACE catalog publication interrupted', updated_at = ?
                   WHERE id = ? AND status = 'running' AND lease_expires_at <= ?`,
                  [now, job.id, now],
                ).changes,
            )
            return count + Number(retired > 0)
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
    operation: (publish: (publication: CatalogLeasePublication) => Promise<void>) => Promise<T>,
    store = this.options.store,
    signal?: AbortSignal,
    preTargetFailure: "release" | "fail" = "release",
  ) {
    requireWorkerID(workerID)
    throwIfAborted(signal)
    await this.recover(store)
    throwIfAborted(signal)
    const now = this.now()
    const job = this.options.database.transaction((connection) => {
      const queued = connection
        .query<
          { count: number },
          []
        >("SELECT count(*) AS count FROM publish_jobs WHERE status = 'running'")
        .get()!.count
      if (queued > 0) throw new Error("catalog publication queue must be drained before synchronization")
      const jobID = `job_${randomSecret()}`
      connection.run(
        `INSERT INTO publish_jobs
          (id, kind, status, lease_owner, lease_expires_at, attempts, error_code, error_summary, created_at, updated_at)
         VALUES (?, 'catalog_rebuild', 'running', ?, ?, 1, ?, ?, ?, ?)`,
        [
          jobID,
          workerID,
          now + (this.options.leaseMilliseconds ?? 5 * 60 * 1_000),
          preTargetFailure === "fail" ? "catalog-delta" : null,
          preTargetFailure === "fail" ? "TRACE catalog publication in progress" : null,
          now,
          now,
        ],
      )
      return readJob(connection, jobID)!
    })
    const state: { revision?: string } = {}
    let pointerPublished = false
    try {
      const value = await operation(async (publication) => {
        if (state.revision) throw new Error("catalog lease cannot move the pointer more than once")
        throwIfAborted(signal)
        if ("delta" in publication)
          await publishCatalogDeltaObjects(
            store,
            { prefix: this.options.ossPrefix },
            publication.delta,
            publication.changedDetails,
          )
        else
          await publishCatalogIndexObjects(
            store,
            { prefix: this.options.ossPrefix },
            publication.index,
            publication.changedDetails,
          )
        throwIfAborted(signal)
        const index = "delta" in publication ? publication.delta : publication.index
        this.persistTarget(job, workerID, index.revision)
        state.revision = index.revision
        await publishCatalogIndexPointer(store, { prefix: this.options.ossPrefix }, index)
        pointerPublished = true
      })
      throwIfAborted(signal)
      this.finalize({ ...job, target_revision: state.revision ?? null })
      return value
    } catch (error) {
      if (!state.revision) {
        if (preTargetFailure === "fail") this.failCatalogLease(job, workerID)
        else this.release(job, workerID)
      }
      if (state.revision && !pointerPublished && !signal?.aborted && (await this.pointerRevision()) !== state.revision)
        this.release(job, workerID)
      throw error
    }
  }

  async publishMirroredSkillHub(
    imports: Pick<
      SkillHubImportStore,
      "mirroredEntries" | "progress" | "completedEvaluations" | "replaceCompletedEvaluationDetails"
    >,
    workerID: string,
    recommendations?: ReadonlySet<string>,
    evaluationLimit = 100,
    signal?: AbortSignal,
  ) {
    const store = signal ? abortableStore(this.options.store, signal) : this.options.store
    throwIfAborted(signal)
    const evaluations = await Promise.all(
      imports.completedEvaluations(evaluationLimit).map((evaluation) => this.materializeSkillHubEvaluation(evaluation, store)),
    )
    const base = await this.basePublication({ skipLegacySkillHub: true }, store)
    const progress = imports.progress()
    const current = new Map(
      base.index.items
        .filter((summary) => summary.source === "skillhub")
        .flatMap((summary) => [summary.id, ...(summary.aliases ?? [])].map((id) => [id, summary] as const)),
    )
    let revision = base.index.revision
    await this.withCatalogLease(workerID, async (publish) => {
      const latest = await this.latestIndex(base.index.sourceStatus, store)
      const publication =
        latest.revision === base.index.revision ? base : await this.basePublication({ skipLegacySkillHub: true }, store)
      const latestEntries = this.entries(publication.index, (summary) => summary.source !== "skillhub")
      const mirrored = imports.mirroredEntries()
      const evaluated = evaluations.filter((evaluation) =>
        mirrored.some(
          (entry) =>
            entry.summary.id === evaluation.entry.summary.id && entry.detailSha256 === evaluation.previousDetailSha256,
        ),
      )
      const evaluationsByDetail = new Map(evaluated.map((evaluation) => [evaluation.previousDetailSha256, evaluation]))
      mirrored.forEach((entry) => {
        const evaluation = evaluationsByDetail.get(entry.detailSha256)
        const mirroredEntry = evaluation?.entry ?? entry
        const ids = [mirroredEntry.summary.id, ...(mirroredEntry.summary.aliases ?? [])]
        const featured = recommendations
          ? ids.some((id) => recommendations.has(id))
          : ids.map((id) => current.get(id)).find(Boolean)?.featured ?? mirroredEntry.summary.featured
        latestEntries.set(key(mirroredEntry.summary.source, mirroredEntry.summary.id), {
          summary:
            mirroredEntry.summary.featured === featured
              ? mirroredEntry.summary
              : { ...mirroredEntry.summary, featured },
          ref: {
            key: normalizeMirrorDetailKey(mirroredEntry.detailKey, mirroredEntry.detailSha256, this.options.ossPrefix),
            sha256: mirroredEntry.detailSha256,
            version: mirroredEntry.summary.version,
          },
        })
      })
      const index = createCatalogIndex({
        entries: latestEntries,
        sourceStatus: { ...publication.index.sourceStatus, skillhub: progress.sourceStatus },
      })
      revision = index.revision
      const changedDetails = new Map(publication.changedDetails)
      evaluated.forEach((evaluation) =>
        changedDetails.set(key(evaluation.entry.summary.source, evaluation.entry.summary.id), evaluation.detail),
      )
      await publish({ index, changedDetails })
      throwIfAborted(signal)
      imports.replaceCompletedEvaluationDetails(evaluated)
    }, store, signal)
    return { revision, mirrored: progress.mirrored }
  }

  async publishCompletedSkillHubEvaluations(
    imports: Pick<SkillHubImportStore, "progress" | "completedEvaluations" | "replaceCompletedEvaluationDetails">,
    workerID: string,
    evaluationLimit = 100,
    signal?: AbortSignal,
  ) {
    if (!Number.isSafeInteger(evaluationLimit) || evaluationLimit < 1 || evaluationLimit > 100)
      throw new Error("SkillHub evaluation publication limit must be between 1 and 100")
    const store = signal ? abortableStore(this.options.store, signal) : this.options.store
    throwIfAborted(signal)
    const materialized = await Promise.all(
      imports.completedEvaluations(evaluationLimit).map((evaluation) => this.materializeSkillHubEvaluation(evaluation, store)),
    )
    let revision: string | undefined
    await this.withCatalogLease(workerID, async (publish) => {
      const completed = new Map(imports.completedEvaluations(evaluationLimit).map((evaluation) => [evaluation.slug, evaluation]))
      const evaluated = materialized.filter((value) => {
        const current = completed.get(value.slug)
        return current?.evaluation.checkedAt === value.checkedAt && current.detailSha256 === value.previousDetailSha256
      })
      if (evaluated.length === 0) return
      const replacements = new Map(
        evaluated.map((value) => [
          key(value.entry.summary.source, value.entry.summary.id),
          {
            summary: value.entry.summary,
            ref: {
              key: normalizeMirrorDetailKey(value.entry.detailKey, value.entry.detailSha256, this.options.ossPrefix),
              sha256: value.entry.detailSha256,
              version: value.entry.summary.version,
            },
            expectedSha256: value.previousDetailSha256,
          },
        ] as const),
      )
      const delta = await prepareCatalogDelta(
        store,
        { prefix: this.options.ossPrefix },
        replacements,
        { skillhub: imports.progress().sourceStatus },
        undefined,
        signal,
      )
      revision = delta.revision
      await publish({
        delta,
        changedDetails: new Map(evaluated.map((value) => [key(value.entry.summary.source, value.entry.summary.id), value.detail])),
      })
      throwIfAborted(signal)
      imports.replaceCompletedEvaluationDetails(evaluated)
    }, store, signal, "fail")
    return { revision, mirrored: imports.progress().mirrored }
  }

  async seedLegacySkillHub(imports: Pick<SkillHubImportStore, "progress" | "seedLegacy">, workerID: string) {
    if (imports.progress().discovered > 0) return 0
    const base = await this.basePublication()
    const legacy = Array.from(base.changedDetails.values())
      .filter((detail) => detail.source === "skillhub")
      .map((detail) => ({ slug: detail.aliases?.[0] ?? detail.id, ...contentAddressDetail(detail) }))
    const seeded = imports.seedLegacy(legacy.map(({ slug, summary, ref }) => ({ slug, summary, detailKey: ref.key, detailSha256: ref.sha256 })))
    if (base.changedDetails.size === 0) return seeded
    await this.withCatalogLease(workerID, async (publish) => {
      const latest = await this.latestIndex(base.index.sourceStatus)
      if (Array.from(latest.details.values()).every((ref) => ref.sha256.length === 64)) return
      await publish(base)
    })
    return seeded
  }

  private claim(workerID: string, preparedJobID?: string) {
    const now = this.now()
    return this.options.database.transaction((connection) => {
      const active = connection
        .query<
          { count: number },
          [number]
        >("SELECT count(*) AS count FROM publish_jobs WHERE status = 'running' AND lease_expires_at > ?")
        .get(now)!.count
      if (active > 0) return undefined
      const candidate = preparedJobID
        ? connection.query<{ id: string }, [string]>("SELECT id FROM publish_jobs WHERE id = ? AND status = 'pending'").get(preparedJobID)
        : connection.query<{ id: string }, []>("SELECT id FROM publish_jobs WHERE status = 'pending' ORDER BY created_at, id LIMIT 1").get()
      if (!candidate) return undefined
      const claimed = connection.run(
        `UPDATE publish_jobs
         SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        [workerID, now + (this.options.leaseMilliseconds ?? 5 * 60 * 1_000), now, candidate.id],
      ).changes
      if (claimed !== 1) return undefined
      const job = readJob(connection, candidate.id)
      if (job?.kind === "publish") insertPublishStarted(connection, job, now)
      return job
    })
  }

  private pending() {
    return this.options.database.read((connection) =>
      connection.query<JobRow, []>(`${jobSelect()} WHERE publish_jobs.status = 'pending' ORDER BY publish_jobs.created_at, publish_jobs.id LIMIT 1`).get(),
    )
  }

  private async preparePublication(job: JobRow) {
    const existing = this.preparations.get(job.id)
    if (existing) return existing
    const prepared = this.preparePublicationObjects(job)
    this.preparations.set(job.id, prepared)
    return prepared.finally(() => this.preparations.delete(job.id))
  }

  private async preparePublicationObjects(job: JobRow) {
    if (!job.submission_id) throw new Error("publish job has no submission")
    await publishCommunityObjects(
      this.options.database,
      { store: this.options.store, publicPrefix: this.options.ossPrefix },
      job.submission_id,
    )
    const candidate = await materializeCommunitySubmission(this.options.database, this.communityOptions(), job.submission_id)
    return { jobID: job.id, candidate }
  }

  private async buildPublication(job: JobRow, prepared?: { readonly jobID: string; readonly candidate: SkillMarket.Detail }) {
    if (!job.submission_id) throw new Error("publish job has no submission")
    const [base, candidate] = await Promise.all([
      this.baseSnapshot(),
      prepared?.jobID === job.id
        ? Promise.resolve(prepared.candidate)
        : materializeCommunitySubmission(this.options.database, this.communityOptions(), job.submission_id),
    ])
    const entry = contentAddressDetail(candidate)
    const entries = this.entries(base.index, (summary) => summary.source !== "community" || summary.id !== candidate.id)
    entries.set(key(candidate.source, candidate.id), entry)
    const changedDetails = new Map(base.changedDetails)
    if (base.index.details.get(key(candidate.source, candidate.id))?.sha256 !== entry.ref.sha256)
      changedDetails.set(key(candidate.source, candidate.id), candidate)
    return {
      index: createCatalogIndex({ entries, sourceStatus: { ...base.index.sourceStatus, community: "fresh" } }),
      changedDetails,
    }
  }

  private async buildRebuild() {
    const [base, community] = await Promise.all([
      this.baseSnapshot(),
      listPublishedCommunity(this.options.database, this.communityOptions()),
    ])
    const entries = this.entries(base.index, (summary) => summary.source !== "community")
    const changedDetails = new Map(base.changedDetails)
    community.forEach((detail) => {
      const entry = contentAddressDetail(detail)
      entries.set(key(detail.source, detail.id), entry)
      if (base.index.details.get(key(detail.source, detail.id))?.sha256 !== entry.ref.sha256)
        changedDetails.set(key(detail.source, detail.id), detail)
    })
    return {
      index: createCatalogIndex({ entries, sourceStatus: { ...base.index.sourceStatus, community: "fresh" } }),
      changedDetails,
    }
  }

  private async baseSnapshot() {
    return this.basePublication()
  }

  private async materializeSkillHubEvaluation(evaluation: CompletedSkillHubEvaluation, store = this.options.store) {
    const key = normalizeMirrorDetailKey(evaluation.detailKey, evaluation.detailSha256, this.options.ossPrefix)
    const body = await store.get(`${this.options.ossPrefix}/${key}`)
    const json = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(new TextDecoder().decode(body))
    const detail = Schema.decodeUnknownSync(SkillMarket.Detail)(json)
    if (detail.source !== "skillhub" || detail.id !== evaluation.summary.id)
      throw new Error(`mirrored SkillHub detail does not match evaluation: ${evaluation.slug}`)
    const evaluated = Schema.decodeUnknownSync(SkillMarket.Detail)({
      ...detail,
      score: 0,
      evaluationScore: evaluation.evaluation.score,
      traceEvaluation: {
        trust: evaluation.evaluation.trust,
        reliability: evaluation.evaluation.reliability,
        adaptability: evaluation.evaluation.adaptability,
        convention: evaluation.evaluation.convention,
        effectiveness: evaluation.evaluation.effectiveness,
        evaluatedAt: new Date(evaluation.evaluation.checkedAt).toISOString(),
      },
    })
    const addressed = contentAddressDetail(evaluated)
    return {
      slug: evaluation.slug,
      previousDetailSha256: evaluation.detailSha256,
      checkedAt: evaluation.evaluation.checkedAt,
      entry: {
        summary: addressed.summary,
        detailKey: addressed.ref.key,
        detailSha256: addressed.ref.sha256,
      },
      detail: evaluated,
    } satisfies EvaluatedSkillHubEntry & { readonly detail: SkillMarket.Detail }
  }

  private async basePublication(options: { readonly skipLegacySkillHub?: boolean } = {}, store = this.options.store): Promise<Publication> {
    const index = await loadCatalogIndexOrMissingPointer(store, { prefix: this.options.ossPrefix })
    if (!index) {
      const sourceStatus = { skillhub: "unavailable", enterprise: "unavailable", community: "fresh" } as const
      return { index: createCatalogIndex({ entries: new Map(), sourceStatus }), changedDetails: new Map() }
    }
    if (Array.from(index.details.values()).every((ref) => ref.sha256.length === 64))
      return { index, changedDetails: new Map() }
    if (options.skipLegacySkillHub) {
      const converted = await Promise.all(
        index.items
          .filter((summary) => summary.source !== "skillhub")
          .map(async (summary) => {
            const detail = await loadCatalogDetail(
              store,
              { prefix: this.options.ossPrefix },
              index,
              summary.source,
              summary.id,
            )
            if (!detail) throw new Error(`legacy catalog detail is missing: ${summary.source}:${summary.id}`)
            return [key(summary.source, summary.id), contentAddressDetail(detail)] as const
          }),
      )
      const details = new Map(index.details)
      converted.forEach(([entryKey, entry]) => details.set(entryKey, entry.ref))
      return {
        index: { ...index, details },
        changedDetails: new Map(converted.map(([entryKey, entry]) => [entryKey, entry.detail])),
      }
    }
    const snapshot = await loadCurrentSnapshot(this.options.store, { prefix: this.options.ossPrefix })
    const entries = new Map<string, { summary: SkillMarket.Summary; ref: CatalogDetailRef }>()
    const changedDetails = new Map<string, SkillMarket.Detail>()
    snapshot.details.forEach((detail, entryKey) => {
      const entry = contentAddressDetail(detail)
      entries.set(entryKey, entry)
      changedDetails.set(entryKey, detail)
    })
    return { index: createCatalogIndex({ entries, sourceStatus: snapshot.sourceStatus }), changedDetails }
  }

  private entries(index: CatalogIndex, keep: (summary: SkillMarket.Summary) => boolean) {
    return new Map(
      index.items.filter(keep).map((summary) => [key(summary.source, summary.id), {
        summary,
        ref: index.details.get(key(summary.source, summary.id))!,
      }] as const),
    )
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

  private release(job: JobRow, workerID: string) {
    const now = this.now()
    this.options.database.transaction((connection) =>
      connection.run(
        "UPDATE publish_jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ?",
        [now, job.id, workerID],
      ),
    )
  }

  private failCatalogLease(job: JobRow, workerID: string) {
    const now = this.now()
    this.options.database.transaction((connection) =>
      connection.run(
        `UPDATE publish_jobs
         SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
             error_code = 'catalog-delta', error_summary = 'TRACE catalog publication failed', updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?`,
        [now, job.id, workerID],
      ),
    )
  }

  private async latestIndex(fallback: SkillMarket.SourceStatus, store = this.options.store) {
    const index = await loadCatalogIndexOrMissingPointer(store, { prefix: this.options.ossPrefix })
    return index ?? createCatalogIndex({ entries: new Map(), sourceStatus: fallback })
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

  private async pointerRevision(store = this.options.store) {
    const pointer = await settled(loadCurrentPointer(store, { prefix: this.options.ossPrefix }))
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
    publish_jobs.error_code,
    publish_jobs.error_summary,
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

function requireWorkerID(value: string) {
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) return value
  throw new Error("publisher worker ID is invalid")
}

function abortableStore(store: PrivateObjectStore, signal: AbortSignal): PrivateObjectStore {
  const putStream = store.putStream
  return {
    async put(key, body, contentType, cacheControl, metadata) {
      await awaitAbortable(signal, () => store.put(key, body, contentType, cacheControl, metadata, { signal }))
    },
    ...(putStream
      ? {
          async putStream(key, body, contentLength, contentType, cacheControl, metadata) {
            await awaitAbortable(signal, () =>
              putStream(key, body, contentLength, contentType, cacheControl, metadata, { signal }),
            )
          },
        }
      : {}),
    get: (key) => awaitAbortable(signal, () => store.get(key, { signal })),
    head: (key) => awaitAbortable(signal, () => store.head(key, { signal })),
    async putPrivate(key, body, contentType, metadata) {
      await awaitAbortable(signal, () => store.putPrivate(key, body, contentType, metadata, { signal }))
    },
    async copy(source, target, contentType, metadata, cacheControl) {
      await awaitAbortable(signal, () => store.copy(source, target, contentType, metadata, cacheControl, { signal }))
    },
    async delete(key) {
      await awaitAbortable(signal, () => store.delete(key, { signal }))
    },
  }
}

async function awaitAbortable<T>(signal: AbortSignal, operation: () => Promise<T>) {
  throwIfAborted(signal)
  try {
    const value = await operation()
    throwIfAborted(signal)
    return value
  } catch (error) {
    throwIfAborted(signal)
    throw error
  }
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error("catalog publication was aborted")
}

export function normalizeMirrorDetailKey(value: string, sha256: string, prefix: string) {
  const expected = `details/${sha256}.json`
  if (value === expected) return value
  if (value === `${prefix.replace(/^\/+|\/+$/g, "")}/${expected}`) return expected
  throw new Error("mirrored SkillHub detail key is invalid")
}

async function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  )
}
