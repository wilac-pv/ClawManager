import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Context, Effect, Layer, Record, Result, Schema, Semaphore } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
  readonly compareAndSet: (
    key: string,
    expected: Info | undefined,
    next: Info | undefined,
  ) => Effect.Effect<boolean, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)
    const semaphore = Semaphore.makeUnsafe(1)

    const read = Effect.fn("Auth.read")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const all = Effect.fn("Auth.all")(function* () {
      return yield* semaphore.withPermits(1)(read())
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return yield* semaphore.withPermits(1)(Effect.map(read(), (data) => data[providerID]))
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          const norm = key.replace(/\/+$/, "")
          const data = yield* read()
          if (norm !== key) delete data[key]
          delete data[norm + "/"]
          yield* fsys
            .writeJson(file, { ...data, [norm]: info }, 0o600)
            .pipe(Effect.mapError(fail("Failed to write auth data")))
        }),
      )
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          const norm = key.replace(/\/+$/, "")
          const data = yield* read()
          delete data[key]
          delete data[norm]
          yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
        }),
      )
    })

    const compareAndSet = Effect.fn("Auth.compareAndSet")(function* (
      key: string,
      expected: Info | undefined,
      next: Info | undefined,
    ) {
      return yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          const norm = key.replace(/\/+$/, "")
          const data = yield* read()
          if (!equals(data[norm] ?? data[key], expected)) return false
          delete data[key]
          delete data[norm]
          delete data[norm + "/"]
          yield* fsys
            .writeJson(file, next ? { ...data, [norm]: next } : data, 0o600)
            .pipe(Effect.mapError(fail("Failed to write auth data")))
          return true
        }),
      )
    })

    return Service.of({ get, all, set, remove, compareAndSet })
  }),
)

export function equals(left: Info | undefined, right: Info | undefined): boolean {
  return sameValue(left, right)
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right)) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).toSorted()
  const rightKeys = Object.keys(rightRecord).toSorted()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]))
  )
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
