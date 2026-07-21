import { loadConfig, type SkillMarketConfig } from "./config"
import { openDatabase, type MarketDatabase } from "./database"
import { createSkillHubEvaluationStore, type ClaimedSkillHubEvaluation, type SkillHubEvaluationStore } from "./skillhub-evaluation-store"
import { loadSkillHubEvaluation, type SkillHubEvaluation } from "./skillhub-evaluation"
import { createSkillHubImportStore, type SkillHubImportStore } from "./skillhub-import-store"
import { emitMarketMetric, type MarketMetricEmitter } from "./metrics"
import { makeS3ObjectStore } from "./oss"
import { createPublisher } from "./publisher"
import { SkillHubRequestError, type Fetcher } from "./skillhub"

interface EvaluationPublication {
  readonly pending: () => { readonly count: number; readonly oldestCheckedAt?: number }
  readonly publish: () => Promise<void>
}

interface EvaluationWorkerOptions {
  readonly workerID: string
  readonly evaluations: Pick<
    SkillHubEvaluationStore,
    "claim" | "renew" | "complete" | "retry" | "markDue"
  >
  readonly loadEvaluation: (slug: string) => Promise<SkillHubEvaluation>
  readonly publication?: EvaluationPublication
  readonly concurrency?: number
  readonly requestsPerMinute?: number
  readonly refreshDays?: number
  readonly publicationBatch?: number
  readonly publicationMinutes?: number
  readonly durationMilliseconds?: number
  readonly leaseMilliseconds?: number
  readonly now?: () => number
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly setInterval?: typeof setInterval
  readonly clearInterval?: typeof clearInterval
  readonly emit?: MarketMetricEmitter
}

export async function runSkillHubEvaluationWorker(options: EvaluationWorkerOptions) {
  const now = options.now ?? Date.now
  const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const concurrency = options.concurrency ?? 2
  const requestsPerMinute = options.requestsPerMinute ?? 60
  const refreshDays = options.refreshDays ?? 7
  const publicationBatch = options.publicationBatch ?? 100
  const publicationMinutes = options.publicationMinutes ?? 30
  const durationMilliseconds = options.durationMilliseconds ?? 50_000
  const leaseMilliseconds = options.leaseMilliseconds ?? 30_000
  requireRange("SkillHub evaluation concurrency", concurrency, 1, 2)
  requireRange("SkillHub evaluation requests per minute", requestsPerMinute, 1, 60)
  requireRange("SkillHub evaluation refresh days", refreshDays, 1, 366)
  requireRange("SkillHub evaluation publication batch", publicationBatch, 1, 1_000)
  requireRange("SkillHub evaluation publication minutes", publicationMinutes, 1, 60)
  requireRange("SkillHub evaluation duration", durationMilliseconds, 1, 50_000)
  requireRange("SkillHub evaluation lease", leaseMilliseconds, 1, 86_400_000)

  const started = now()
  const interval = Math.ceil(60_000 / requestsPerMinute)
  let nextStart = started
  let completed = 0
  let retryWait = 0
  let failed = 0
  let stale = 0
  let storageFailures = 0
  let published = 0
  let publicationFailures = 0
  const schedule = async () => {
    const timestamp = now()
    const delay = Math.max(0, nextStart - timestamp)
    nextStart = Math.max(nextStart, timestamp) + interval
    if (delay > 0) await wait(delay)
  }
  const publish = async () => {
    if (!options.publication) return
    const pending = options.publication.pending()
    const dueByCount = pending.count >= publicationBatch
    const dueByTime = pending.oldestCheckedAt !== undefined && now() - pending.oldestCheckedAt >= publicationMinutes * 60 * 1_000
    if (!dueByCount && !dueByTime) return
    try {
      await options.publication.publish()
      published += 1
    } catch {
      publicationFailures += 1
    }
  }

  options.evaluations.markDue(refreshDays * 24 * 60 * 60 * 1_000)
  while (now() - started < durationMilliseconds) {
    const claimed = options.evaluations.claim(options.workerID, concurrency, leaseMilliseconds)
    if (claimed.length === 0) break
    const outcomes = await Promise.all(
      claimed.map((item) =>
        evaluateClaim({
          item,
          workerID: options.workerID,
          evaluations: options.evaluations,
          loadEvaluation: options.loadEvaluation,
          leaseMilliseconds,
          schedule,
          setInterval: options.setInterval ?? setInterval,
          clearInterval: options.clearInterval ?? clearInterval,
        }),
      ),
    )
    outcomes.forEach((outcome) => {
      if (outcome === "completed") completed += 1
      if (outcome === "retry_wait") retryWait += 1
      if (outcome === "failed") failed += 1
      if (outcome === "stale") stale += 1
      if (outcome === "storage_failure") storageFailures += 1
    })
    await publish()
  }
  await publish()
  ;(options.emit ?? emitMarketMetric)({
    skill_market_skillhub_evaluation_result: {
      completed,
      retry_wait: retryWait,
      failed,
      stale,
      storage_failure: storageFailures,
      published,
      publication_failure: publicationFailures,
    },
  })
  return { completed, retryWait, failed, stale, storageFailures, published, publicationFailures }
}

async function evaluateClaim(options: {
  readonly item: ClaimedSkillHubEvaluation
  readonly workerID: string
  readonly evaluations: Pick<SkillHubEvaluationStore, "renew" | "complete" | "retry">
  readonly loadEvaluation: (slug: string) => Promise<SkillHubEvaluation>
  readonly leaseMilliseconds: number
  readonly schedule: () => Promise<void>
  readonly setInterval: typeof setInterval
  readonly clearInterval: typeof clearInterval
}) {
  const heartbeat = options.setInterval(() => {
    try {
      options.evaluations.renew(options.workerID, options.item.slug, options.leaseMilliseconds)
    } catch {
      // The foreground operation will fence itself before mutating durable state.
    }
  }, Math.max(1, Math.floor(options.leaseMilliseconds / 2)))
  try {
    await options.schedule()
    if (!options.evaluations.renew(options.workerID, options.item.slug, options.leaseMilliseconds)) return "stale" as const
    const evaluation = await options.loadEvaluation(options.item.slug)
    if (!options.evaluations.renew(options.workerID, options.item.slug, options.leaseMilliseconds)) return "stale" as const
    return options.evaluations.complete(options.workerID, options.item.slug, evaluation) ? "completed" as const : "stale" as const
  } catch (error) {
    try {
      const permanent = error instanceof SkillHubRequestError && error.permanent
      const retried = options.evaluations.retry(
        options.workerID,
        options.item.slug,
        permanent ? "SkillHub evaluation response is invalid" : "SkillHub evaluation request failed",
        permanent ? { maximumAttempts: 1 } : undefined,
      )
      if (!retried) return "stale" as const
      return permanent ? "failed" as const : "retry_wait" as const
    } catch {
      return "storage_failure" as const
    }
  } finally {
    options.clearInterval(heartbeat)
  }
}

export async function runConfiguredSkillHubEvaluationWorker(
  options: {
    readonly config?: SkillMarketConfig
    readonly fetcher?: Fetcher
    readonly workerID?: string
    readonly emit?: MarketMetricEmitter
  } = {},
) {
  const config = options.config ?? loadConfig()
  const database = await openDatabase({
    databasePath: config.databasePath,
    migrationBackupDirectory: config.migrationBackupDirectory,
    emit: options.emit,
  })
  try {
    return await runWithDatabase(database, config, options)
  } finally {
    database.close()
  }
}

async function runWithDatabase(
  database: MarketDatabase,
  config: SkillMarketConfig,
  options: {
    readonly fetcher?: Fetcher
    readonly workerID?: string
    readonly emit?: MarketMetricEmitter
  },
) {
  const imports = createSkillHubImportStore({ database })
  const evaluations = createSkillHubEvaluationStore({ database })
  const publisher = createPublisher({
    database,
    store: makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket }),
    ossPrefix: config.ossPrefix,
    publicBaseUrl: config.publicBaseUrl,
    webBaseUrl: config.webBaseUrl,
  })
  const workerID = options.workerID ?? `evaluation-${process.pid}`
  const fetcher = options.fetcher ?? fetch
  return runSkillHubEvaluationWorker({
    workerID,
    evaluations,
    loadEvaluation: (slug) => loadSkillHubEvaluation(fetcher, config.skillhubBaseUrl, slug),
    publication: evaluationPublication(imports, publisher, workerID, config.skillhubEvaluationPublishBatch),
    concurrency: config.skillhubEvaluationConcurrency,
    requestsPerMinute: config.skillhubEvaluationRequestsPerMinute,
    refreshDays: config.skillhubEvaluationRefreshDays,
    publicationBatch: config.skillhubEvaluationPublishBatch,
    publicationMinutes: config.skillhubEvaluationPublishMinutes,
    durationMilliseconds: config.skillhubEvaluationDurationMilliseconds,
    emit: options.emit,
  })
}

function evaluationPublication(
  imports: SkillHubImportStore,
  publisher: ReturnType<typeof createPublisher>,
  workerID: string,
  batch: number,
): EvaluationPublication {
  return {
    pending() {
      const evaluations = imports.completedEvaluations(batch)
      return {
        count: evaluations.length,
        ...(evaluations[0] ? { oldestCheckedAt: evaluations[0].evaluation.checkedAt } : {}),
      }
    },
    publish: () => publisher.publishMirroredSkillHub(imports, workerID, undefined, batch).then(() => undefined),
  }
}

function requireRange(name: string, value: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
}

if (import.meta.main) await runConfiguredSkillHubEvaluationWorker()
