import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Hooks } from "@opencode-ai/plugin"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Auth } from "@/auth"
import { Plugin } from "@/plugin"
import { ProviderAuth } from "@/provider/auth"
import { testEffect } from "../lib/effect"

const providerID = ProviderV2.ID.make("attempt-test")
const it = testEffect(Layer.empty)

function layer(input: { auth: Auth.Interface; hooks: Hooks }) {
  return LayerNode.compile(ProviderAuth.node, [
    [Auth.node, Layer.succeed(Auth.Service, Auth.Service.of(input.auth))],
    [
      Plugin.node,
      Layer.succeed(
        Plugin.Service,
        Plugin.Service.of({
          list: () => Effect.succeed([input.hooks]),
          init: () => Effect.void,
          trigger: (_name, _input, output) => Effect.succeed(output),
        }),
      ),
    ],
  ])
}

function harness(input: {
  previous?: Auth.Info
  blockRollbackRead?: boolean
  setFailure?: boolean
  cancelFailure?: boolean
}) {
  const setStarted = Promise.withResolvers<void>()
  const releaseSet = Promise.withResolvers<void>()
  const rollbackReadStarted = Promise.withResolvers<void>()
  const releaseRollbackRead = Promise.withResolvers<void>()
  let current = input.previous
  const auth = Auth.Service.of({
    get: () =>
      Effect.promise(async () => {
        if (input.blockRollbackRead && current?.type === "api" && current.key === "new-key") {
          rollbackReadStarted.resolve()
          throw new Error("compensation must use atomic compareAndSet")
        }
        return current
      }),
    all: () => Effect.succeed(current ? { [providerID]: current } : {}),
    set: (_key, info) => {
      if (info.type !== "api" || info.key !== "new-key") return Effect.sync(() => void (current = info))
      return Effect.promise(async () => {
        setStarted.resolve()
        await releaseSet.promise
      }).pipe(
        Effect.andThen(
          input.setFailure
            ? Effect.fail(new Auth.AuthError({ message: "set failed" }))
            : Effect.sync(() => void (current = info)),
        ),
      )
    },
    remove: () => Effect.sync(() => void (current = undefined)),
    compareAndSet: (_key, expected, next) =>
      Effect.promise(async () => {
        if (input.blockRollbackRead) {
          rollbackReadStarted.resolve()
          await releaseRollbackRead.promise
        }
        if (JSON.stringify(current) !== JSON.stringify(expected)) return false
        current = next
        return true
      }),
  })
  const hooks: Hooks = {
    auth: {
      provider: providerID,
      methods: [
        {
          type: "oauth",
          label: "Attempt test",
          async authorize() {
            return {
              url: "https://example.test/oauth",
              method: "auto" as const,
              instructions: "test",
              async cancel() {
                if (input.cancelFailure) throw new Error("plugin cancel failed")
              },
              async callback() {
                return { type: "success" as const, key: "new-key" }
              },
            }
          },
        },
      ],
    },
  }
  return {
    auth,
    hooks,
    setStarted,
    releaseSet,
    rollbackReadStarted,
    releaseRollbackRead,
    cancelFailure: input.cancelFailure,
    current: () => current,
    replace: (info: Auth.Info) => void (current = info),
  }
}

function cancelBlockedWrite(input: ReturnType<typeof harness>, afterRelease?: Effect.Effect<void>) {
  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    yield* service.authorize({ providerID, method: 0 })
    const callback = yield* service.callback({ providerID, method: 0 }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => input.setStarted.promise)
    let canceled = false
    const cancel = yield* service
      .cancel({ providerID })
      .pipe(
        Effect.ensuring(Effect.sync(() => void (canceled = true))),
        Effect.forkScoped,
      )

    yield* Effect.sleep("10 millis")
    expect(canceled).toBe(false)
    input.releaseSet.resolve()
    if (afterRelease) yield* afterRelease

    const callbackExit = yield* Fiber.await(callback)
    expect(Exit.isFailure(callbackExit)).toBe(true)
    const cancelExit = yield* Fiber.await(cancel)
    expect(Exit.isFailure(cancelExit)).toBe(input.cancelFailure === true)
  }).pipe(Effect.provide(layer(input)))
}

it.instance("cancel joins a blocked credential write and restores the previous credential", () => {
  const previous = { type: "api" as const, key: "old-key" }
  const input = harness({ previous })
  return cancelBlockedWrite(input).pipe(Effect.andThen(Effect.sync(() => expect(input.current()).toEqual(previous))))
})

it.instance("cancel removes the attempted credential when no previous credential existed", () => {
  const input = harness({})
  return cancelBlockedWrite(input).pipe(Effect.andThen(Effect.sync(() => expect(input.current()).toBeUndefined())))
})

it.instance("cancel preserves a newer credential observed before compensation", () => {
  const input = harness({ previous: { type: "api", key: "old-key" }, blockRollbackRead: true })
  const newer = { type: "api" as const, key: "external-key" }
  return cancelBlockedWrite(
    input,
    Effect.gen(function* () {
      yield* Effect.promise(() => input.rollbackReadStarted.promise)
      input.replace(newer)
      input.releaseRollbackRead.resolve()
    }),
  ).pipe(Effect.andThen(Effect.sync(() => expect(input.current()).toEqual(newer))))
})

it.instance("cancel completes after a blocked credential write fails", () => {
  const previous = { type: "api" as const, key: "old-key" }
  const input = harness({ previous, setFailure: true })
  return cancelBlockedWrite(input).pipe(Effect.andThen(Effect.sync(() => expect(input.current()).toEqual(previous))))
})

it.instance("plugin cancel failure still joins persistence and restores the previous credential", () => {
  const previous = { type: "api" as const, key: "old-key" }
  const input = harness({ previous, cancelFailure: true })
  return cancelBlockedWrite(input).pipe(Effect.andThen(Effect.sync(() => expect(input.current()).toEqual(previous))))
})

it.instance("plugin cancel failure does not join a callback that never entered persistence", () => {
  const callbackStarted = Promise.withResolvers<void>()
  const callbackReleased = Promise.withResolvers<void>()
  let writes = 0
  const auth = Auth.Service.of({
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed({}),
    set: () => Effect.sync(() => void writes++),
    remove: () => Effect.void,
    compareAndSet: () => Effect.succeed(false),
  })
  const hooks: Hooks = {
    auth: {
      provider: providerID,
      methods: [
        {
          type: "oauth",
          label: "Pending callback",
          async authorize() {
            return {
              url: "https://example.test/oauth",
              method: "auto" as const,
              instructions: "test",
              async cancel() {
                throw new Error("plugin cancel failed")
              },
              async callback() {
                callbackStarted.resolve()
                await callbackReleased.promise
                return { type: "success" as const, key: "late-key" }
              },
            }
          },
        },
      ],
    },
  }

  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    yield* service.authorize({ providerID, method: 0 })
    const callback = yield* service.callback({ providerID, method: 0 }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => callbackStarted.promise)
    const canceled = yield* service.cancel({ providerID }).pipe(Effect.exit)
    expect(Exit.isFailure(canceled)).toBe(true)
    expect(writes).toBe(0)
    callbackReleased.resolve()
    expect(Exit.isFailure(yield* Fiber.await(callback))).toBe(true)
    expect(writes).toBe(0)
  }).pipe(Effect.provide(layer({ auth, hooks })))
})

it.instance("authorize supersession uses the same cancellation transaction", () => {
  const previous = { type: "api" as const, key: "old-key" }
  const input = harness({ previous })
  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    yield* service.authorize({ providerID, method: 0 })
    const callback = yield* service.callback({ providerID, method: 0 }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => input.setStarted.promise)
    let superseded = false
    const authorize = yield* service
      .authorize({ providerID, method: 0 })
      .pipe(
        Effect.ensuring(Effect.sync(() => void (superseded = true))),
        Effect.forkScoped,
      )

    yield* Effect.sleep("10 millis")
    expect(superseded).toBe(false)
    input.releaseSet.resolve()
    expect(Exit.isFailure(yield* Fiber.await(callback))).toBe(true)
    expect(Exit.isSuccess(yield* Fiber.await(authorize))).toBe(true)
    expect(input.current()).toEqual(previous)
    yield* service.cancel({ providerID })
  }).pipe(Effect.provide(layer(input)))
})
