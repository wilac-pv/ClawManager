import { loadConfig, type SkillMarketConfig } from "./config"
import { openDatabase, type MarketDatabase } from "./database"
import { discoverSkillHub } from "./skillhub-discovery"
import { createSkillHubImportStore, type SkillHubImportStore } from "./skillhub-import-store"
import { createSkillHubMirror, type SkillHubMirror } from "./skillhub-mirror"
import { loadSkillHubRecommendations, loadSkillHubRecord, type Fetcher } from "./skillhub"
import { emitMarketMetric, type MarketMetricEmitter } from "./metrics"
import { makeS3ObjectStore, type PrivateObjectStore } from "./oss"
import { CatalogPublicationBusyError, createPublisher } from "./publisher"

type MirrorBatch = Awaited<ReturnType<SkillHubMirror["runBatch"]>>

export interface SkillHubWorkerWake {
  readonly wake: () => Promise<void>
}

export function createSkillHubWorkerWake(options: {
  readonly config?: SkillMarketConfig
  readonly run?: () => Promise<unknown>
  readonly emit?: MarketMetricEmitter
}): SkillHubWorkerWake {
  const run = options.run ?? (() => runConfiguredSkillHubWorker({ config: options.config, emit: options.emit }))
  let active: Promise<void> | undefined
  let rerun = false

  const drain = async () => {
    do {
      rerun = false
      try {
        await run()
      } catch {
        try {
          options.emit?.({ skill_market_skillhub_wake_result: { failure: 1 } })
        } catch {
          // Metrics must not turn an advisory wake into an unhandled rejection.
        }
      }
    } while (rerun)
  }

  return {
    wake() {
      if (active) {
        rerun = true
        return active
      }
      const next = drain().finally(() => {
        if (active === next) active = undefined
      })
      active = next
      return next
    },
  }
}

export async function runSkillHubWorker(options: {
  readonly workerID: string
  readonly recover?: () => Promise<unknown>
  readonly discover: () => Promise<void>
  readonly mirror: Pick<SkillHubMirror, "runBatch">
  readonly progress: () => { readonly mirrored: number }
  readonly publicationCheckpoint: () => { readonly lastPublishedCount: number; readonly lastPublishedAt?: string; readonly startedAt?: string }
  readonly shouldPublish: (
    progress: { readonly mirrored: number },
    checkpoint: { readonly lastPublishedCount: number; readonly lastPublishedAt?: string; readonly startedAt?: string },
  ) => boolean
  readonly publish?: () => Promise<boolean | void>
  readonly recordPublication?: (mirroredCount: number) => unknown
  readonly durationMilliseconds?: number
  readonly now?: () => number
  readonly emit?: MarketMetricEmitter
}) {
  const now = options.now ?? Date.now
  const started = now()
  await options.recover?.()
  await options.discover()
  let total: MirrorBatch = { mirrored: 0, retryWait: 0, rejected: 0 }
  while (now() - started < (options.durationMilliseconds ?? 50_000)) {
    const batch = await options.mirror.runBatch(options.workerID)
    total = {
      mirrored: total.mirrored + batch.mirrored,
      retryWait: total.retryWait + batch.retryWait,
      rejected: total.rejected + batch.rejected,
    }
    if (batch.mirrored === 0 && batch.retryWait === 0 && batch.rejected === 0) break
  }
  const progress = options.progress()
  let published = Boolean(options.publish && options.shouldPublish(progress, options.publicationCheckpoint()))
  if (published) {
    published = (await options.publish!()) !== false
    if (published) options.recordPublication?.(progress.mirrored)
  }
  ;(options.emit ?? emitMarketMetric)({
    skill_market_skillhub_mirror_result: {
      mirrored: total.mirrored,
      retry_wait: total.retryWait,
      rejected: total.rejected,
      published: Number(published),
    },
  })
  return { ...total, published }
}

export async function runConfiguredSkillHubWorker(
  options: {
    readonly config?: SkillMarketConfig
    readonly fetcher?: Fetcher
    readonly publish?: () => Promise<boolean | void>
    readonly shouldPublish?: (progress: ReturnType<SkillHubImportStore["progress"]>) => boolean
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
    return await runWithDatabase(
      database,
      makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket }),
      config,
      options,
    )
  } finally {
    database.close()
  }
}

async function runWithDatabase(
  database: MarketDatabase,
  store: PrivateObjectStore,
  config: SkillMarketConfig,
  options: {
    readonly fetcher?: Fetcher
    readonly publish?: () => Promise<boolean | void>
    readonly shouldPublish?: (progress: ReturnType<SkillHubImportStore["progress"]>) => boolean
    readonly workerID?: string
    readonly emit?: MarketMetricEmitter
  },
) {
  const imports = createSkillHubImportStore({
    database,
    metadataConcurrency: config.skillhubMetadataConcurrency,
    packageConcurrency: config.skillhubPackageConcurrency,
  })
  recoverExpiredClaims(database)
  const fetcher = options.fetcher ?? fetch
  const mirror = createSkillHubMirror({
    imports,
    store,
    fetcher,
    loadRecord: (item) => loadSkillHubRecord(fetcher, config.skillhubBaseUrl, item.list),
    allowedHosts: config.allowedHosts,
    publicBaseUrl: config.publicBaseUrl,
    objectPrefix: config.ossPrefix,
    metadataConcurrency: config.skillhubMetadataConcurrency,
    packageConcurrency: config.skillhubPackageConcurrency,
    memorySoftLimitMb: config.skillhubMemorySoftLimitMb,
  })
  const publisher = createPublisher({
    database,
    store,
    ossPrefix: config.ossPrefix,
    publicBaseUrl: config.publicBaseUrl,
    webBaseUrl: config.webBaseUrl,
  })
  const workerID = options.workerID ?? `skillhub-${process.pid}`
  await publisher.seedLegacySkillHub(imports, workerID)
  return runSkillHubWorker({
    workerID,
    recover: () => publisher.recover(),
    discover: () =>
      discoverSkillHub({
        fetcher,
        baseUrl: config.skillhubBaseUrl,
        imports,
        pageConcurrency: config.skillhubPageConcurrency,
        maxPageBatches: 1,
        limit: config.skillhubLimit,
        refresh: config.skillhubLimit === undefined,
      }).then(() => undefined),
    mirror,
    progress: imports.progress,
    publicationCheckpoint: imports.publicationCheckpoint,
    shouldPublish: (progress, checkpoint) =>
      options.shouldPublish?.(imports.progress()) ??
      shouldPublishSkillHub(progress, checkpoint, {
        batch: config.skillhubPublishBatch,
        minutes: config.skillhubPublishMinutes,
        now: Date.now,
      }),
    publish: async () => {
      if (options.publish) return options.publish()
      const recommendations = await loadSkillHubRecommendations(fetcher, config.skillhubBaseUrl).then(
        (value) => value,
        (error: unknown) => {
          console.warn(
            JSON.stringify({
              skill_market_showcase_error: {
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          )
          return undefined
        },
      )
      return publisher.publishMirroredSkillHub(imports, workerID, recommendations).then(
        () => true,
        (error: unknown) => {
          if (error instanceof CatalogPublicationBusyError) return false
          throw error
        },
      )
    },
    recordPublication: imports.recordPublication,
    emit: options.emit,
  })
}

export function shouldPublishSkillHub(
  progress: { readonly mirrored: number; readonly sourceStatus?: string; readonly pending?: number; readonly running?: number; readonly retryWait?: number },
  checkpoint: { readonly lastPublishedCount: number; readonly lastPublishedAt?: string; readonly startedAt?: string },
  options: { readonly batch: number; readonly minutes: number; readonly now: () => number },
) {
  if (progress.mirrored < checkpoint.lastPublishedCount) return false
  if (progress.mirrored - checkpoint.lastPublishedCount >= options.batch) return true
  const since = checkpoint.lastPublishedCount === 0 ? checkpoint.lastPublishedAt ?? checkpoint.startedAt : undefined
  if (since !== undefined && options.now() - Date.parse(since) >= options.minutes * 60 * 1_000) return true
  return progress.sourceStatus === "fresh" && progress.pending === 0 && progress.running === 0 && progress.retryWait === 0
}

function recoverExpiredClaims(database: MarketDatabase) {
  database.transaction((connection) =>
    connection.run(
      "UPDATE skillhub_import_items SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'running' AND lease_expires_at <= ?",
      [Date.now(), Date.now()],
    ),
  )
}

if (import.meta.main) await runConfiguredSkillHubWorker()
