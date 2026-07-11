import { Schema, Effect } from "effect"
import { getRuyingSessionStatus } from "./ruying-session"

export const message = "请先运行 ruying-code login 完成 GWM SSO 登录"

export class RuyingLoginRequiredError extends Schema.TaggedErrorClass<RuyingLoginRequiredError>()(
  "RuyingLoginRequiredError",
  { message: Schema.String },
) {}

export const requireRuyingLogin = Effect.fn("Auth.requireRuyingLogin")(function* () {
  if ((yield* getRuyingSessionStatus()).loggedIn) return
  return yield* new RuyingLoginRequiredError({ message })
})

export * as RuyingGate from "./ruying-gate"
