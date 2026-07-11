import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context } from "effect"
import { sql, eq, asc } from "drizzle-orm"
import { ShareRevocationQuarantineTable } from "@opencode-ai/core/share/sql"
import { open } from "node:fs/promises"

export interface Interface {
  migrate: () => Effect.Effect<void>
  list: () => Effect.Effect<Array<{ id: string; sessionID: string; timeCreated: number }>>
  exportTo: (path: string) => Effect.Effect<number, unknown>
  complete: (id: string, confirmed: boolean) => Effect.Effect<boolean, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareRevocationQuarantine") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const migrate = Effect.fn("ShareRevocationQuarantine.migrate")(function* () {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`
              INSERT OR IGNORE INTO share_revocation_quarantine
                (id, session_id, secret, url, time_created, time_updated)
              SELECT id, session_id, secret, url, time_created, time_updated
              FROM session_share
            `)
            yield* tx.run(sql`DELETE FROM session_share`)
          }),
        )
        .pipe(Effect.orDie)
    })

    const list = Effect.fn("ShareRevocationQuarantine.list")(function* () {
      yield* migrate()
      return yield* db
        .select({
          id: ShareRevocationQuarantineTable.id,
          sessionID: ShareRevocationQuarantineTable.session_id,
          timeCreated: ShareRevocationQuarantineTable.time_created,
        })
        .from(ShareRevocationQuarantineTable)
        .orderBy(asc(ShareRevocationQuarantineTable.time_created), asc(ShareRevocationQuarantineTable.id))
        .all()
        .pipe(Effect.orDie)
    })

    const exportTo = Effect.fn("ShareRevocationQuarantine.exportTo")(function* (path: string) {
      yield* migrate()
      const rows = yield* db
        .select()
        .from(ShareRevocationQuarantineTable)
        .orderBy(asc(ShareRevocationQuarantineTable.time_created), asc(ShareRevocationQuarantineTable.id))
        .all()
        .pipe(Effect.orDie)
      yield* Effect.tryPromise(async () => {
        const file = await open(path, "wx", 0o600)
        try {
          await file.writeFile(`${JSON.stringify(rows, null, 2)}\n`, "utf8")
        } finally {
          await file.close()
        }
      })
      return rows.length
    })

    const complete = Effect.fn("ShareRevocationQuarantine.complete")(function* (id: string, confirmed: boolean) {
      if (!confirmed) return yield* Effect.fail(new Error("Manual remote revocation must be confirmed"))
      return !!(yield* db
        .delete(ShareRevocationQuarantineTable)
        .where(eq(ShareRevocationQuarantineTable.id, id))
        .returning({ id: ShareRevocationQuarantineTable.id })
        .get()
        .pipe(Effect.orDie))
    })

    return Service.of({ migrate, list, exportTo, complete })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node],
})

export * as ShareRevocationQuarantine from "./quarantine"
