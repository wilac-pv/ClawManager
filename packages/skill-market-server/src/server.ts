import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { createServer } from "node:http"
import { createAuth } from "./auth"
import { loadConfig } from "./config"
import { openDatabase } from "./database"
import { createMarketRoutes } from "./handlers"
import { createModeration } from "./moderation"
import { loadCurrentSnapshot, makeS3ObjectStore } from "./oss"
import { bootstrapAdmins, createSecurity } from "./security"
import { createSubmissions } from "./submissions"

const main = Effect.scoped(
  Effect.gen(function* () {
    const config = loadConfig()
    const database = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          openDatabase({
            databasePath: config.databasePath,
            migrationBackupDirectory: config.migrationBackupDirectory,
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
    })
    const submissions = createSubmissions({ database })
    const moderation = createModeration({ database, security })
    const routes = createMarketRoutes({
      loadSnapshot: () => loadCurrentSnapshot(store, { prefix: config.ossPrefix }),
      auth,
      security,
      submissions,
      moderation,
      store,
      privatePrefix: config.privateOssPrefix,
      webOrigin: config.webOrigin,
      sessionCookieName: config.sessionCookieName,
      cookieSecure: config.cookieSecure,
    })
    return yield* Layer.launch(
      HttpRouter.serve(routes, { disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { host: "0.0.0.0", port: config.port })),
      ),
    )
  }),
)

NodeRuntime.runMain(main)
