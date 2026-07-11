import { beforeEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { AccountRepo } from "../../src/account/repo"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "@/session/session"
import { ShareNext } from "@/share/share-next"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const env = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]))
const it = testEffect(env)
const noNetwork = HttpClient.make(() => Effect.die("unexpected sharing network call"))
const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, noNetwork)] as const
const layer = LayerNode.compile(
  LayerNode.group([ShareNext.node, EventV2Bridge.node, Session.node, SessionProjector.node, AccountRepo.node, Database.node]),
  [replacement],
)

beforeEach(async () => {
  await resetDatabase()
})

describe("ShareNext OEM boundary", () => {
  it.live("rejects every direct create without network or persistence", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({ title: "test" })
        const exit = yield* ShareNext.Service.use((service) => Effect.exit(service.create(session.id)))

        expect(Exit.isFailure(exit)).toBe(true)
        const { db } = yield* Database.Service
        expect(
          yield* db
            .select()
            .from(SessionShareTable)
            .where(eq(SessionShareTable.session_id, session.id))
            .get()
            .pipe(Effect.orDie),
        ).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    ),
  )

  it.live("quarantines migrated revocation material without a remote delete", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* (yield* Session.Service).create({ title: "test" })
        const { db } = yield* Database.Service
        yield* db
          .insert(SessionShareTable)
          .values({ session_id: session.id, id: "shr_old", secret: "secret", url: "https://opncd.ai/s/old" })
          .run()
          .pipe(Effect.orDie)

        yield* ShareNext.Service.use((service) => service.remove(session.id))

        expect(
          yield* db
            .select()
            .from(SessionShareTable)
            .where(eq(SessionShareTable.session_id, session.id))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ id: "shr_old", secret: "secret" })
      }).pipe(Effect.provide(layer)),
    ),
  )
})
