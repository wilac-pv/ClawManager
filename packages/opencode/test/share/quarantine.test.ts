import { beforeEach, describe, expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ShareRevocationQuarantineTable } from "@opencode-ai/core/share/sql"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { ShareRevocationQuarantine } from "@/share/quarantine"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const env = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]))
const it = testEffect(env)
const layer = LayerNode.compile(LayerNode.group([ShareRevocationQuarantine.node, Database.node]))

beforeEach(async () => {
  await resetDatabase()
})

test("db CLI exposes bounded local share quarantine administration", async () => {
  const source = await Bun.file(new URL("../../src/cli/cmd/db.ts", import.meta.url)).text()
  expect(source).toContain('command: "share-quarantine"')
  expect(source).toContain('command: "list"')
  expect(source).toContain('command: "export <file>"')
  expect(source).toContain('command: "complete <id>"')
  expect(source).toContain('option("confirmed"')
  expect(source).not.toContain("share.secret")
})

describe("share revocation quarantine admin workflow", () => {
  it.live("lists without secrets, exports to a new 0600 file, and requires confirmation to complete", () =>
    provideTmpdirInstance((directory) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .insert(ShareRevocationQuarantineTable)
          .values({ session_id: "ses_deleted", id: "shr_manual", secret: "revocation-secret", url: "https://share" })
          .run()
          .pipe(Effect.orDie)

        const quarantine = yield* ShareRevocationQuarantine.Service
        expect("list" in quarantine).toBe(true)
        expect("exportTo" in quarantine).toBe(true)
        expect("complete" in quarantine).toBe(true)

        const rows = yield* quarantine.list()
        expect(rows).toEqual([expect.objectContaining({ id: "shr_manual", sessionID: "ses_deleted" })])
        expect(JSON.stringify(rows)).not.toContain("revocation-secret")

        const target = path.join(directory, "revocations.json")
        expect(yield* quarantine.exportTo(target)).toBe(1)
        expect((yield* Effect.promise(() => Bun.file(target).json()))[0]).toMatchObject({
          id: "shr_manual",
          secret: "revocation-secret",
        })
        expect((yield* Effect.promise(() => stat(target))).mode & 0o777).toBe(0o600)
        expect(Exit.isFailure(yield* Effect.exit(quarantine.exportTo(target)))).toBe(true)

        expect(Exit.isFailure(yield* Effect.exit(quarantine.complete("shr_manual", false)))).toBe(true)
        expect(
          yield* db
            .select()
            .from(ShareRevocationQuarantineTable)
            .where(eq(ShareRevocationQuarantineTable.id, "shr_manual"))
            .get()
            .pipe(Effect.orDie),
        ).toBeDefined()

        expect(yield* quarantine.complete("shr_manual", true)).toBe(true)
        expect(
          yield* db
            .select()
            .from(ShareRevocationQuarantineTable)
            .where(eq(ShareRevocationQuarantineTable.id, "shr_manual"))
            .get()
            .pipe(Effect.orDie),
        ).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    ),
  )
})
