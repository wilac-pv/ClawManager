import { Schema, Effect } from "effect"
import { getRuyingSessionStatus } from "./ruying-session"
import { Brand } from "@opencode-ai/core/brand/brand"

export const message = "请先运行 ruying-code login 完成 GWM SSO 登录"

export class RuyingLoginRequiredError extends Schema.TaggedErrorClass<RuyingLoginRequiredError>()(
  "RuyingLoginRequiredError",
  { message: Schema.String },
) {}

export const requireRuyingLogin = Effect.fn("Auth.requireRuyingLogin")(function* () {
  if ((yield* getRuyingSessionStatus()).loggedIn) return
  return yield* new RuyingLoginRequiredError({ message })
})

export class RuyingProviderRequiredError extends Schema.TaggedErrorClass<RuyingProviderRequiredError>()(
  "RuyingProviderRequiredError",
  { providerID: Schema.String, message: Schema.String },
) {}

export const requireRuyingProvider = Effect.fn("Auth.requireRuyingProvider")(function* (providerID: string) {
  if (providerID === Brand.profile.providerID) return
  return yield* new RuyingProviderRequiredError({
    providerID,
    message: `Only the ${Brand.profile.providerID} provider may execute models`,
  })
})

export * as RuyingGate from "./ruying-gate"
