import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { AuthOAuthResult, Hooks } from "@opencode-ai/plugin"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Auth } from "@/auth"
import { InstanceState } from "@/effect/instance-state"
import { optional } from "@opencode-ai/core/schema"
import { Plugin } from "../plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Array as Arr, Cause, Context, Deferred, Effect, Exit, Layer, Record, Result, Schema, Semaphore } from "effect"

const When = Schema.Struct({
  key: Schema.String,
  op: Schema.Literals(["eq", "neq"]),
  value: Schema.String,
})

const TextPrompt = Schema.Struct({
  type: Schema.Literal("text"),
  key: Schema.String,
  message: Schema.String,
  placeholder: optional(Schema.String),
  when: optional(When),
})

const SelectOption = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  hint: optional(Schema.String),
})

const SelectPrompt = Schema.Struct({
  type: Schema.Literal("select"),
  key: Schema.String,
  message: Schema.String,
  options: Schema.Array(SelectOption),
  when: optional(When),
})

const Prompt = Schema.Union([TextPrompt, SelectPrompt])

export class Method extends Schema.Class<Method>("ProviderAuthMethod")({
  type: Schema.Literals(["oauth", "api"]),
  label: Schema.String,
  prompts: optional(Schema.Array(Prompt)),
}) {}

export const Methods = Schema.Record(Schema.String, Schema.Array(Method))
export type Methods = typeof Methods.Type

export class Authorization extends Schema.Class<Authorization>("ProviderAuthAuthorization")({
  url: Schema.String,
  method: Schema.Literals(["auto", "code"]),
  instructions: Schema.String,
}) {}

export const AuthorizeInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({ description: "Prompt inputs" }),
})
export type AuthorizeInput = Schema.Schema.Type<typeof AuthorizeInput>

export const CallbackInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  code: Schema.optional(Schema.String).annotate({ description: "OAuth authorization code" }),
})
export type CallbackInput = Schema.Schema.Type<typeof CallbackInput>

export class OauthMissing extends Schema.TaggedErrorClass<OauthMissing>()("ProviderAuthOauthMissing", {
  providerID: ProviderV2.ID,
}) {}

export class OauthCodeMissing extends Schema.TaggedErrorClass<OauthCodeMissing>()("ProviderAuthOauthCodeMissing", {
  providerID: ProviderV2.ID,
}) {}

export class OauthCallbackFailed extends Schema.TaggedErrorClass<OauthCallbackFailed>()(
  "ProviderAuthOauthCallbackFailed",
  {},
) {}

export class ValidationFailed extends Schema.TaggedErrorClass<ValidationFailed>()("ProviderAuthValidationFailed", {
  field: Schema.String,
  message: Schema.String,
}) {}

export type Error = Auth.AuthError | OauthMissing | OauthCodeMissing | OauthCallbackFailed | ValidationFailed

type Hook = NonNullable<Hooks["auth"]>

export interface Interface {
  readonly methods: () => Effect.Effect<Methods>
  readonly allocatedProviderCount: () => Effect.Effect<number>
  readonly authorize: (
    input: {
      providerID: ProviderV2.ID
    } & AuthorizeInput,
  ) => Effect.Effect<Authorization | undefined, Error>
  readonly callback: (input: { providerID: ProviderV2.ID } & CallbackInput) => Effect.Effect<void, Error>
  readonly cancel: (input: { providerID: ProviderV2.ID }) => Effect.Effect<void>
}

interface State {
  hooks: Record<ProviderV2.ID, Hook>
  providers: Map<ProviderV2.ID, ProviderState>
}

interface ProviderState {
  lock: ReturnType<typeof Semaphore.makeUnsafe>
  authorize: ReturnType<typeof Semaphore.makeUnsafe>
  attempt?: Attempt
}

interface Attempt {
  result: AuthOAuthResult
  canceled: boolean
  previous?: Auth.Info
  next?: Auth.Info
  callback?: Deferred.Deferred<void, Error>
  cancel?: Deferred.Deferred<void>
  rollbackFailure?: unknown
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderAuth") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, Auth.Service | Plugin.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("ProviderAuth.state")(function* () {
        const plugins = yield* plugin.list()
        return {
          hooks: Record.fromEntries(
            Arr.filterMap(plugins, (x) =>
              x.auth?.provider !== undefined
                ? Result.succeed([ProviderV2.ID.make(x.auth.provider), x.auth] as const)
                : Result.failVoid,
            ),
          ),
          providers: new Map<ProviderV2.ID, ProviderState>(),
        }
      }),
    )

    const decode = Schema.decodeUnknownSync(Methods)
    const methods = Effect.fn("ProviderAuth.methods")(function* () {
      const hooks = (yield* InstanceState.get(state)).hooks
      return decode(
        Record.map(hooks, (item) =>
          item.methods.map((method) => ({
            type: method.type,
            label: method.label,
            ...(method.prompts && {
              prompts: method.prompts.map((prompt) => {
                if (prompt.type === "select") {
                  return {
                    type: "select" as const,
                    key: prompt.key,
                    message: prompt.message,
                    options: prompt.options,
                    ...(prompt.when && { when: prompt.when }),
                  }
                }
                return {
                  type: "text" as const,
                  key: prompt.key,
                  message: prompt.message,
                  ...(prompt.placeholder && { placeholder: prompt.placeholder }),
                  ...(prompt.when && { when: prompt.when }),
                }
              }),
            }),
          })),
        ),
      )
    })

    const allocatedProviderCount = Effect.fn("ProviderAuth.allocatedProviderCount")(function* () {
      return (yield* InstanceState.get(state)).providers.size
    })

    const restore = Effect.fn("ProviderAuth.restore")(function* (input: {
      providerID: ProviderV2.ID
      attempt: Attempt
    }) {
      if (!input.attempt.next) return
      yield* auth.compareAndSet(input.providerID, input.attempt.next, input.attempt.previous)
    })

    const providerState = (value: State, providerID: ProviderV2.ID) => {
      const current = value.providers.get(providerID)
      if (current) return current
      const next: ProviderState = {
        lock: Semaphore.makeUnsafe(1),
        authorize: Semaphore.makeUnsafe(1),
      }
      value.providers.set(providerID, next)
      return next
    }

    const cancelCurrentEffect = Effect.fn("ProviderAuth.cancelCurrent")(function* (input: {
      providerID: ProviderV2.ID
      provider: ProviderState
    }) {
      const selected = yield* input.provider.lock.withPermits(1)(
        Effect.gen(function* () {
          const attempt = input.provider.attempt
          if (!attempt) return
          if (attempt.cancel) return { owner: false as const, attempt, task: attempt.cancel }
          attempt.canceled = true
          attempt.cancel = yield* Deferred.make<void>()
          return { owner: true as const, attempt, task: attempt.cancel }
        }),
      )
      if (!selected) return
      if (selected.owner) {
        const exit = yield* Effect.gen(function* () {
          const pluginCancel = yield* Effect.promise(
            () => selected.attempt.result.cancel?.() ?? Promise.resolve(),
          ).pipe(Effect.exit)
          const callback = yield* input.provider.lock.withPermits(1)(Effect.sync(() => selected.attempt.callback))
          if (callback) yield* Deferred.await(callback).pipe(Effect.exit)
          // Durable compensation failure wins over plugin cancellation failure because
          // it means the credential invariant could not be re-established.
          if (selected.attempt.rollbackFailure) return yield* Effect.die(selected.attempt.rollbackFailure)
          if (Exit.isFailure(pluginCancel)) return yield* pluginCancel
        }).pipe(Effect.exit)
        yield* input.provider.lock.withPermits(1)(
          Deferred.done(selected.task, exit).pipe(Effect.ignore),
        )
      }
      yield* Deferred.await(selected.task)
    })
    const cancelCurrent = (input: { providerID: ProviderV2.ID; provider: ProviderState }) =>
      cancelCurrentEffect(input).pipe(Effect.uninterruptible)

    const authorize = Effect.fn("ProviderAuth.authorize")(function* (
      input: { providerID: ProviderV2.ID } & AuthorizeInput,
    ) {
      const value = yield* InstanceState.get(state)
      if (!Object.hasOwn(value.hooks, input.providerID)) {
        return yield* new OauthMissing({ providerID: input.providerID })
      }
      const hook = value.hooks[input.providerID]
      const method = hook.methods[input.method]
      if (method.type !== "oauth") return
      const provider = providerState(value, input.providerID)

      return yield* provider.authorize.withPermits(1)(
        Effect.gen(function* () {
          yield* cancelCurrent({ providerID: input.providerID, provider })

          if (method.prompts && input.inputs) {
            for (const prompt of method.prompts) {
              if (prompt.type === "text" && prompt.validate && input.inputs[prompt.key] !== undefined) {
                const error = prompt.validate(input.inputs[prompt.key])
                if (error) return yield* new ValidationFailed({ field: prompt.key, message: error })
              }
            }
          }

          const result = yield* Effect.promise(() => method.authorize(input.inputs))
          yield* provider.lock.withPermits(1)(
            Effect.sync(() => {
              provider.attempt = {
                result,
                canceled: false,
              }
            }),
          )
          return {
            url: result.url,
            method: result.method,
            instructions: result.instructions,
          }
        }),
      ).pipe(Effect.uninterruptible)
    })

    const callbackEffect = Effect.fn("ProviderAuth.callback")(function* (
      input: { providerID: ProviderV2.ID } & CallbackInput,
    ) {
      const value = yield* InstanceState.get(state)
      if (!Object.hasOwn(value.hooks, input.providerID)) {
        return yield* new OauthMissing({ providerID: input.providerID })
      }
      const provider = providerState(value, input.providerID)
      const selected = yield* provider.lock.withPermits(1)(
        Effect.gen(function* () {
          const attempt = provider.attempt
          if (!attempt) return yield* new OauthMissing({ providerID: input.providerID })
          if (attempt.canceled) return yield* new OauthCallbackFailed({})
          if (attempt.callback) return { owner: false as const, attempt, task: attempt.callback }
          if (attempt.result.method === "code" && !input.code) {
            return yield* new OauthCodeMissing({ providerID: input.providerID })
          }
          attempt.callback = yield* Deferred.make<void, Error>()
          return { owner: true as const, attempt, task: attempt.callback }
        }),
      )

      if (selected.owner) {
        const exit = yield* Effect.gen(function* () {
          const oauth = selected.attempt.result
          const result = yield* Effect.promise(() => {
            if (oauth.method === "code") return oauth.callback(input.code!)
            return oauth.callback()
          })
          if (!result || result.type !== "success") return yield* new OauthCallbackFailed({})

          const next: Auth.Info = "key" in result
            ? {
                type: "api",
                key: result.key,
                ...(result.metadata ? { metadata: result.metadata } : {}),
              }
            : (() => {
                const { type: _, provider: __, refresh, access, expires, ...extra } = result
                return {
                  type: "oauth" as const,
                  access,
                  refresh,
                  expires,
                  ...extra,
                }
              })()

          const admitted = yield* provider.lock.withPermits(1)(
            Effect.sync(() => {
              if (provider.attempt !== selected.attempt || selected.attempt.canceled) return false
              selected.attempt.next = next
              return true
            }),
          )
          if (!admitted) return yield* new OauthCallbackFailed({})

          selected.attempt.previous = yield* auth.get(input.providerID)
          const active = yield* provider.lock.withPermits(1)(
            Effect.sync(() => provider.attempt === selected.attempt && !selected.attempt.canceled),
          )
          if (!active) return yield* new OauthCallbackFailed({})

          const write = yield* auth.set(input.providerID, next).pipe(Effect.exit)
          if (Exit.isFailure(write)) return yield* write
          const committed = yield* provider.lock.withPermits(1)(
            Effect.gen(function* () {
              if (provider.attempt !== selected.attempt || selected.attempt.canceled) return false
              provider.attempt = undefined
              yield* Deferred.done(selected.task, write).pipe(Effect.ignore)
              return true
            }),
          )
          if (committed) return

          const rollback = yield* restore({ providerID: input.providerID, attempt: selected.attempt }).pipe(Effect.exit)
          if (Exit.isFailure(rollback)) {
            selected.attempt.rollbackFailure = Cause.squash(rollback.cause)
            return yield* rollback
          }
          return yield* new OauthCallbackFailed({})
        }).pipe(Effect.exit)

        yield* provider.lock.withPermits(1)(
          Effect.gen(function* () {
            if (provider.attempt === selected.attempt && !selected.attempt.cancel) provider.attempt = undefined
            yield* Deferred.done(selected.task, exit).pipe(Effect.ignore)
          }),
        )
      }
      yield* Deferred.await(selected.task)
    })
    const callback = (input: { providerID: ProviderV2.ID } & CallbackInput) =>
      callbackEffect(input).pipe(Effect.uninterruptible)

    const cancel = Effect.fn("ProviderAuth.cancel")(function* (input: { providerID: ProviderV2.ID }) {
      const value = yield* InstanceState.get(state)
      if (!Object.hasOwn(value.hooks, input.providerID)) return
      const provider = providerState(value, input.providerID)
      yield* cancelCurrent({ providerID: input.providerID, provider })
    })

    return Service.of({ methods, allocatedProviderCount, authorize, callback, cancel })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Auth.node, Plugin.node] })

export * as ProviderAuth from "./auth"
