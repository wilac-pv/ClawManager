import { loadConfig, type SkillMarketConfig } from "./config"
import { openDatabase, type MarketDatabase } from "./database"
import { discoverSkillHub } from "./skillhub-discovery"
import { createSkillHubImportStore, type SkillHubImportStore } from "./skillhub-import-store"
import { createSkillHubMirror, type SkillHubMirror } from "./skillhub-mirror"
import { loadSkillHubRecord, type Fetcher } from "./skillhub"
import { emitMarketMetric, type MarketMetricEmitter } from "./metrics"
import { makeS3ObjectStore, type PrivateObjectStore } from "./oss"

type MirrorBatch = Awaited<ReturnType<SkillHubMirror["runBatch"]>>

export async function runSkillHubWorker(options: {
  readonly workerID: string
  readonly discover: () => Promise<void>
  readonly mirror: Pick<SkillHubMirror, "runBatch">
  readonly progress: () => { readonly mirrored: number }
  readonly publicationCheckpoint: () => { readonly lastPublishedCount: number; readonly lastPublishedAt?: string }
  readonly shouldPublish: (
    progress: { readonly mirrored: number },
    checkpoint: { readonly lastPublishedCount: number; readonly lastPublishedAt?: string },
  ) => boolean
  readonly publish?: () => Promise<void>
  readonly durationMilliseconds?: number
  readonly now?: () => number
  readonly emit?: MarketMetricEmitter
}) {
  const now = options.now ?? Date.now
  const started = now()
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
  const published = Boolean(options.publish && options.shouldPublish(progress, options.publicationCheckpoint()))
  if (published) await options.publish!()
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

export async function runConfiguredSkillHubWorker(options: {
  readonly config?: SkillMarketConfig
  readonly fetcher?: Fetcher
  readonly publish?: () => Promise<void>
  readonly shouldPublish?: (progress: ReturnType<SkillHubImportStore["progress"]>) => boolean
  readonly workerID?: string
  readonly emit?: MarketMetricEmitter
} = {}) {
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
    readonly publish?: () => Promise<void>
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
    objectPrefix: config.privateOssPrefix,
    metadataConcurrency: config.skillhubMetadataConcurrency,
    packageConcurrency: config.skillhubPackageConcurrency,
    memorySoftLimitMb: config.skillhubMemorySoftLimitMb,
  })
  return runSkillHubWorker({
    workerID: options.workerID ?? `skillhub-${process.pid}`,
    discover: () =>
      discoverSkillHub({
        fetcher,
        baseUrl: config.skillhubBaseUrl,
        imports,
        pageConcurrency: config.skillhubPageConcurrency,
      }).then(() => undefined),
    mirror,
    progress: imports.progress,
    publicationCheckpoint: imports.publicationCheckpoint,
    shouldPublish: (progress, checkpoint) =>
      options.shouldPublish?.(imports.progress()) ??
      (progress.mirrored - checkpoint.lastPublishedCount >= config.skillhubPublishBatch ||
        (checkpoint.lastPublishedAt !== undefined &&
          Date.now() - Date.parse(checkpoint.lastPublishedAt) >= config.skillhubPublishMinutes * 60 * 1_000)),
    publish: options.publish,
    emit: options.emit,
  })
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
