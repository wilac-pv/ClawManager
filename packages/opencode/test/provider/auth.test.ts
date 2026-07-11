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
  blockCancel?: boolean
  setFailure?: boolean
  cancelFailure?: boolean
}) {
  const setStarted = Promise.withResolvers<void>()
  const releaseSet = Promise.withResolvers<void>()
  const rollbackReadStarted = Promise.withResolvers<void>()
  const releaseRollbackRead = Promise.withResolvers<void>()
  const cancelStarted = Promise.withResolvers<void>()
  const releaseCancel = Promise.withResolvers<void>()
  let current = input.previous
  let authorizeCalls = 0
  let callbackCalls = 0
  let cancelCalls = 0
  let setCalls = 0
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
      setCalls++
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
            authorizeCalls++
            return {
              url: "https://example.test/oauth",
              method: "auto" as const,
              instructions: "test",
              async cancel() {
                cancelCalls++
                cancelStarted.resolve()
                if (input.blockCancel) await releaseCancel.promise
                if (input.cancelFailure) throw new Error("plugin cancel failed")
              },
              async callback() {
                callbackCalls++
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
    cancelStarted,
    releaseCancel,
    cancelFailure: input.cancelFailure,
    authorizeCalls: () => authorizeCalls,
    callbackCalls: () => callbackCalls,
    cancelCalls: () => cancelCalls,
    setCalls: () => setCalls,
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

it.instance("plugin cancel failure still joins an active callback", () => {
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
    let cancelDone = false
    const cancel = yield* service
      .cancel({ providerID })
      .pipe(Effect.ensuring(Effect.sync(() => void (cancelDone = true))), Effect.forkScoped)
    yield* Effect.sleep("10 millis")
    expect(cancelDone).toBe(false)
    expect(writes).toBe(0)
    callbackReleased.resolve()
    expect(Exit.isFailure(yield* Fiber.await(callback))).toBe(true)
    expect(Exit.isFailure(yield* Fiber.await(cancel))).toBe(true)
    expect(writes).toBe(0)
  }).pipe(Effect.provide(layer({ auth, hooks })))
})

it.instance("cancel before callback start completes without waiting for a callback", () => {
  const input = harness({})
  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    yield* service.authorize({ providerID, method: 0 })
    yield* service.cancel({ providerID })
    expect(input.cancelCalls()).toBe(1)
    expect(Exit.isFailure(yield* service.callback({ providerID, method: 0 }).pipe(Effect.exit))).toBe(true)
  }).pipe(Effect.provide(layer(input)))
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

it.instance("same-tick callbacks share one plugin callback and credential write", () => {
  const input = harness({})
  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    yield* service.authorize({ providerID, method: 0 })
    const first = yield* service.callback({ providerID, method: 0 }).pipe(Effect.forkScoped)
    const second = yield* service.callback({ providerID, method: 0 }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => input.setStarted.promise)
    input.releaseSet.resolve()

    const firstExit = yield* Fiber.await(first)
    const secondExit = yield* Fiber.await(second)
    expect(Exit.isSuccess(firstExit)).toBe(true)
    expect(Exit.isSuccess(secondExit)).toBe(true)
    expect(input.callbackCalls()).toBe(1)
    expect(input.setCalls()).toBe(1)
  }).pipe(Effect.provide(layer(input)))
})

it.instance("concurrent authorizes serialize and supersede the first attempt", () => {
  const firstStarted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  let authorizes = 0
  let firstCancels = 0
  let current: Auth.Info | undefined
  const auth = Auth.Service.of({
    get: () => Effect.succeed(current),
    all: () => Effect.succeed(current ? { [providerID]: current } : {}),
    set: (_key, info) => Effect.sync(() => void (current = info)),
    remove: () => Effect.sync(() => void (current = undefined)),
    compareAndSet: (_key, expected, next) =>
      Effect.sync(() => {
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
          label: "Serialized authorize",
          async authorize() {
            const invocation = ++authorizes
            if (invocation === 1) {
              firstStarted.resolve()
              await releaseFirst.promise
            }
            return {
              url: `https://example.test/oauth/${invocation}`,
              method: "auto" as const,
              instructions: "test",
              async cancel() {
                if (invocation === 1) firstCancels++
              },
              async callback() {
                return { type: "success" as const, key: `key-${invocation}` }
              },
            }
          },
        },
      ],
    },
  }

  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    const first = yield* service.authorize({ providerID, method: 0 }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => firstStarted.promise)
    const second = yield* service.authorize({ providerID, method: 0 }).pipe(Effect.forkScoped)
    yield* Effect.sleep("10 millis")
    expect(authorizes).toBe(1)
    releaseFirst.resolve()
    expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
    expect(Exit.isSuccess(yield* Fiber.await(second))).toBe(true)
    yield* service.callback({ providerID, method: 0 })
    expect(current).toEqual({ type: "api", key: "key-2" })
    expect(firstCancels).toBe(1)
  }).pipe(Effect.provide(layer({ auth, hooks })))
})

it.instance("duplicate cancels join one cancellation transaction", () => {
  const input = harness({ previous: { type: "api", key: "old-key" } })
  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    yield* service.authorize({ providerID, method: 0 })
    const callback = yield* service.callback({ providerID, method: 0 }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => input.setStarted.promise)
    let firstDone = false
    let secondDone = false
    const first = yield* service
      .cancel({ providerID })
      .pipe(Effect.ensuring(Effect.sync(() => void (firstDone = true))), Effect.forkScoped)
    const second = yield* service
      .cancel({ providerID })
      .pipe(Effect.ensuring(Effect.sync(() => void (secondDone = true))), Effect.forkScoped)

    yield* Effect.sleep("10 millis")
    expect(firstDone).toBe(false)
    expect(secondDone).toBe(false)
    expect(input.cancelCalls()).toBe(1)
    input.releaseSet.resolve()
    expect(Exit.isFailure(yield* Fiber.await(callback))).toBe(true)
    expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
    expect(Exit.isSuccess(yield* Fiber.await(second))).toBe(true)
    expect(input.cancelCalls()).toBe(1)
  }).pipe(Effect.provide(layer(input)))
})

it.instance("a delayed duplicate cancel joins the completed failure tombstone", () => {
  const input = harness({ blockCancel: true, cancelFailure: true })
  const duplicateStarted = Promise.withResolvers<void>()
  const releaseDuplicate = Promise.withResolvers<void>()
  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    yield* service.authorize({ providerID, method: 0 })
    const first = yield* service.cancel({ providerID }).pipe(Effect.exit, Effect.forkScoped)
    yield* Effect.promise(() => input.cancelStarted.promise)
    const duplicate = yield* Effect.gen(function* () {
      duplicateStarted.resolve()
      yield* Effect.promise(() => releaseDuplicate.promise)
      return yield* service.cancel({ providerID }).pipe(Effect.exit)
    }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => duplicateStarted.promise)

    input.releaseCancel.resolve()
    const firstExit = yield* Fiber.join(first)
    expect(Exit.isFailure(firstExit)).toBe(true)
    releaseDuplicate.resolve()
    const duplicateExit = yield* Fiber.join(duplicate)
    expect(Exit.isFailure(duplicateExit)).toBe(true)
    if (Exit.isFailure(firstExit) && Exit.isFailure(duplicateExit)) {
      expect(duplicateExit.cause).toEqual(firstExit.cause)
    }
    expect(input.cancelCalls()).toBe(1)
  }).pipe(Effect.provide(layer(input)))
})

it.instance("authorize joins a completed cancel failure without replacing the tombstone", () => {
  const input = harness({ blockCancel: true, cancelFailure: true })
  const authorizeStarted = Promise.withResolvers<void>()
  const releaseAuthorize = Promise.withResolvers<void>()
  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    yield* service.authorize({ providerID, method: 0 })
    const cancel = yield* service.cancel({ providerID }).pipe(Effect.exit, Effect.forkScoped)
    yield* Effect.promise(() => input.cancelStarted.promise)
    const replacement = yield* Effect.gen(function* () {
      authorizeStarted.resolve()
      yield* Effect.promise(() => releaseAuthorize.promise)
      yield* service.authorize({ providerID, method: 0 })
    }).pipe(Effect.exit, Effect.forkScoped)
    yield* Effect.promise(() => authorizeStarted.promise)

    input.releaseCancel.resolve()
    const cancelExit = yield* Fiber.join(cancel)
    expect(Exit.isFailure(cancelExit)).toBe(true)
    releaseAuthorize.resolve()
    const replacementExit = yield* Fiber.join(replacement)
    expect(Exit.isFailure(replacementExit)).toBe(true)
    if (Exit.isFailure(cancelExit) && Exit.isFailure(replacementExit)) {
      expect(replacementExit.cause).toEqual(cancelExit.cause)
    }
    expect(input.authorizeCalls()).toBe(1)
    expect(input.cancelCalls()).toBe(1)
  }).pipe(Effect.provide(layer(input)))
})

it.instance("authorize joins a successful cancel tombstone and installs one replacement", () => {
  const input = harness({ blockCancel: true })
  const authorizeStarted = Promise.withResolvers<void>()
  const releaseAuthorize = Promise.withResolvers<void>()
  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    yield* service.authorize({ providerID, method: 0 })
    const cancel = yield* service.cancel({ providerID }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => input.cancelStarted.promise)
    const replacement = yield* Effect.gen(function* () {
      authorizeStarted.resolve()
      yield* Effect.promise(() => releaseAuthorize.promise)
      yield* service.authorize({ providerID, method: 0 })
    }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => authorizeStarted.promise)

    input.releaseCancel.resolve()
    expect(Exit.isSuccess(yield* Fiber.await(cancel))).toBe(true)
    releaseAuthorize.resolve()
    expect(Exit.isSuccess(yield* Fiber.await(replacement))).toBe(true)
    expect(input.authorizeCalls()).toBe(2)
    expect(input.cancelCalls()).toBe(1)
    const callback = yield* service.callback({ providerID, method: 0 }).pipe(Effect.forkScoped)
    yield* Effect.promise(() => input.setStarted.promise)
    input.releaseSet.resolve()
    expect(Exit.isSuccess(yield* Fiber.await(callback))).toBe(true)
  }).pipe(Effect.provide(layer(input)))
})

it.instance("unknown provider traffic does not allocate provider state", () => {
  const input = harness({})
  const unknown = Array.from({ length: 500 }, (_, index) => ProviderV2.ID.make(`unknown-${index}`))
  return Effect.gen(function* () {
    const service = yield* ProviderAuth.Service
    expect(yield* service.allocatedProviderCount()).toBe(0)

    const callbacks = yield* Effect.forEach(unknown, (id) =>
      service.callback({ providerID: id, method: 0 }).pipe(Effect.exit),
    )
    yield* Effect.forEach(unknown, (id) => service.cancel({ providerID: id }))
    const authorizes = yield* Effect.forEach(unknown, (id) =>
      service.authorize({ providerID: id, method: 0 }).pipe(Effect.exit),
    )

    expect(callbacks.every(Exit.isFailure)).toBe(true)
    expect(authorizes.every(Exit.isFailure)).toBe(true)
    expect(yield* service.allocatedProviderCount()).toBe(0)
    expect(input.authorizeCalls()).toBe(0)

    yield* service.authorize({ providerID, method: 0 })
    expect(yield* service.allocatedProviderCount()).toBe(1)
    yield* service.cancel({ providerID })
    expect(yield* service.allocatedProviderCount()).toBe(1)
  }).pipe(Effect.provide(layer(input)))
})
