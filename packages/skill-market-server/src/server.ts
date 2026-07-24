import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import { createAuth } from "./auth"
import { createCatalogReader } from "./catalog-reader"
import { loadConfig } from "./config"
import { openDatabase } from "./database"
import { createMarketRoutes } from "./handlers"
import { emitMarketMetric } from "./metrics"
import { createExpertPackages } from "./expert-packages"
import { createFavorites } from "./favorites"
import { createModeration } from "./moderation"
import { makeS3ObjectStore } from "./oss"
import { createPublisher } from "./publisher"
import { bootstrapAdmins, createSecurity } from "./security"
import { createSkillHubImportAdmin } from "./skillhub-import-admin"
import { createSkillHubImportStore } from "./skillhub-import-store"
import { createSkillHubEvaluationStore } from "./skillhub-evaluation-store"
import { createSubmissions } from "./submissions"
import { createWorker, type Worker } from "./worker"

const main = Effect.scoped(
  Effect.gen(function* () {
    const config = loadConfig()
    const database = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          openDatabase({
            databasePath: config.databasePath,
            migrationBackupDirectory: config.migrationBackupDirectory,
            emit: emitMarketMetric,
          }),
        catch: (error) => error,
      }),
      (database) => Effect.sync(() => database.close()),
    )
    bootstrapAdmins(database, config.bootstrapAdmins)
    const store = makeS3ObjectStore({
      endpoint: config.ossEndpoint,
      region: config.ossRegion,
      bucket: config.ossBucket,
    })
    const security = createSecurity({
      database,
      webOrigin: config.webOrigin,
      sessionIdleMilliseconds: config.sessionIdleMilliseconds,
      sessionAbsoluteMilliseconds: config.sessionAbsoluteMilliseconds,
    })
    const auth = createAuth({
      database,
      security,
      ssoLoginUrl: config.ssoLoginUrl,
      adminApiBaseUrl: config.adminApiBaseUrl,
      apiPublicUrl: config.apiPublicUrl,
      sessionCookieName: config.sessionCookieName,
      cookieSecure: config.cookieSecure,
      loginAttemptMilliseconds: config.loginAttemptMilliseconds,
      sessionAbsoluteMilliseconds: config.sessionAbsoluteMilliseconds,
      emit: emitMarketMetric,
    })
    const state: { worker?: Worker } = {}
    const wake = () => {
      void state.worker?.wake("server").catch(() => undefined)
    }
    const submissions = createSubmissions({ database, onValidationReady: wake })
    const moderation = createModeration({ database, security })
    const imports = createSkillHubImportStore({
      database,
      metadataConcurrency: config.skillhubMetadataConcurrency,
      packageConcurrency: config.skillhubPackageConcurrency,
    })
    const evaluations = createSkillHubEvaluationStore({ database })
    const expertPackages = createExpertPackages({ database, baseUrl: config.skillhubBaseUrl })
    yield* Effect.promise(() =>
      expertPackages.refresh().catch((error) =>
        console.warn(
          JSON.stringify({
            skill_market_expert_packages_sync_error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        ),
      ),
    )
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        setInterval(
          () =>
            void expertPackages.refresh().catch((error) =>
              console.warn(
                JSON.stringify({
                  skill_market_expert_packages_sync_error: {
                    message: error instanceof Error ? error.message : String(error),
                  },
                }),
              ),
            ),
          6 * 60 * 60 * 1_000,
        ),
      ),
      (timer) => Effect.sync(() => clearInterval(timer)),
    )
    const favorites = createFavorites({ database })
    const skillhubImportAdmin = createSkillHubImportAdmin({ database, security, imports, evaluations })
    const worker = createWorker({
      database,
      submissions,
      store,
      publisher: createPublisher({
        database,
        store,
        ossPrefix: config.ossPrefix,
        publicBaseUrl: config.publicBaseUrl,
        webBaseUrl: config.webBaseUrl,
      }),
      emit: emitMarketMetric,
      sessionIdleMilliseconds: config.sessionIdleMilliseconds,
    })
    state.worker = worker
    worker.cleanup()
    yield* Effect.promise(() => worker.drain("server-startup"))
    const routes = createMarketRoutes({
      catalog: createCatalogReader({ store, prefix: config.ossPrefix }),
      auth,
      security,
      submissions,
      moderation,
      expertPackages,
      favorites,
      skillhubImportAdmin,
      store,
      privatePrefix: config.privateOssPrefix,
      publicPrefix: config.ossPrefix,
      webOrigin: config.webOrigin,
      webBaseUrl: config.webBaseUrl,
      sessionCookieName: config.sessionCookieName,
      cookieSecure: config.cookieSecure,
      sessionCookieMaxAgeSeconds: config.sessionCookieMaxAgeSeconds,
      onWorkReady: wake,
      emit: emitMarketMetric,
    })
    return yield* Layer.launch(
      HttpRouter.serve(routes, { disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { host: "0.0.0.0", port: config.port })),
      ),
    )
  }),
)

NodeRuntime.runMain(main)
