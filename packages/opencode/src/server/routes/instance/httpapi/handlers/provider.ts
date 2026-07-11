import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError, RuyingSessionLogoutApiError } from "../groups/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Brand } from "@opencode-ai/core/brand/brand"
import { getRuyingSessionStatus, logoutRuyingSession } from "@/auth/ruying-session"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { EffectBridge } from "@/effect/bridge"

export function visibleProviderIDs(all: string[], enabled?: Set<string>, disabled = new Set<string>()) {
  return all.filter((id) => (enabled ? enabled.has(id) : id === Brand.profile.providerID) && !disabled.has(id))
}

export function scheduleRuyingLogoutDisposal<R>(input: {
  dispose: Effect.Effect<void, unknown, R>
  fork: (effect: Effect.Effect<void, never, R>) => unknown
}) {
  input.fork(
    input.dispose.pipe(
      Effect.catchCause((cause) => Effect.logWarning("ruying logout disposal failed", { cause })),
    ),
  )
}

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const bridge = yield* EffectBridge.make()

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const all = yield* ModelsDev.Service.use((s) => s.get())
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const connectedAll = yield* provider.list()
      const methods = yield* svc.methods()
      const visible = new Set(
        visibleProviderIDs(
          [...new Set([...Object.keys(all), ...Object.keys(connectedAll), ...Object.keys(methods)])],
          enabled,
          disabled,
        ),
      )
      const filtered = Object.fromEntries(Object.entries(all).filter(([id]) => visible.has(id)))
      const connected = Object.fromEntries(Object.entries(connectedAll).filter(([id]) => visible.has(id)))
      const providers = Object.assign(
        mapValues(filtered, (item) => Provider.fromModelsDevProvider(item)),
        connected,
      )

      // Surface plugin-only auth providers (e.g. SSO providers not in models.dev
      // or config) so they're selectable in /connect before the first login.
      // Kept out of `providers` so they don't break defaultModelIDs (no models yet).
      const extra: Record<string, Provider.Info> = {}
      for (const id of Object.keys(methods)) {
        if (providers[id] || !visible.has(id)) continue
        extra[id] = {
          id: ProviderV2.ID.make(id),
          name: config.provider?.[id]?.name ?? id,
          source: "custom",
          env: [],
          options: {},
          models: {},
        }
      }

      return {
        all: [...Object.values(providers), ...Object.values(extra)].map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
        connected: Object.keys(connected),
      }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      const config = yield* cfg.get()
      const methods = yield* svc.methods()
      const visible = new Set(
        visibleProviderIDs(
          Object.keys(methods),
          config.enabled_providers ? new Set(config.enabled_providers) : undefined,
          new Set(config.disabled_providers ?? []),
        ),
      )
      return Object.fromEntries(Object.entries(methods).filter(([id]) => visible.has(id)))
    })

    const ruyingStatus = Effect.fn("ProviderHttpApi.ruyingStatus")(function* () {
      return yield* getRuyingSessionStatus()
    })

    const ruyingLogout = Effect.fn("ProviderHttpApi.ruyingLogout")(function* () {
      yield* logoutRuyingSession().pipe(
        Effect.mapError((error) => new RuyingSessionLogoutApiError({ message: error.message })),
      )
      scheduleRuyingLogoutDisposal({
        dispose: disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }),
        fork: bridge.fork,
      })
      return true
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      return true
    })

    const cancel = Effect.fn("ProviderHttpApi.cancel")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      yield* svc.cancel({ providerID: ctx.params.providerID })
      return true
    })

    return handlers
      .handle("list", list)
      .handle("auth", auth)
      .handle("ruyingStatus", ruyingStatus)
      .handle("ruyingLogout", ruyingLogout)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
      .handle("cancel", cancel)
  }),
)
