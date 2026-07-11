import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { scheduleRuyingLogoutDisposal } from "@/server/routes/instance/httpapi/handlers/provider"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstanceStore } from "@/project/instance-store"
import { GlobalBus } from "@/bus/global"

test("scheduled disposal cannot delay or fail a committed logout response", async () => {
  const started = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  let fiber: Fiber.Fiber<void> | undefined

  scheduleRuyingLogoutDisposal({
    dispose: Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(Effect.fail(new Error("dispose failed"))),
    ),
    fork: (effect) => {
      fiber = Effect.runFork(effect)
    },
  })

  await Effect.runPromise(Deferred.await(started))
  expect(fiber).toBeDefined()
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect(Exit.isSuccess(await Effect.runPromise(Fiber.await(fiber!)))).toBe(true)
})

test("failed instance disposal still emits exactly one global disposal event", async () => {
  const events: string[] = []
  const listener = (event: { payload: { type?: string } }) => {
    if (event.payload.type === "global.disposed") events.push(event.payload.type)
  }
  GlobalBus.on("event", listener)

  await Effect.runPromise(
    disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }).pipe(
      Effect.provide(
        Layer.mock(InstanceStore.Service, {
          disposeAll: () => Effect.die(new Error("dispose failed")),
        }),
      ),
      Effect.ensuring(Effect.sync(() => GlobalBus.off("event", listener))),
    ),
  )

  expect(events).toEqual(["global.disposed"])
})
