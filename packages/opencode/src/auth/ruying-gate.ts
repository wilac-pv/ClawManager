import { Schema, Effect } from "effect"
import { Config } from "@/config/config"
import { Auth } from "."

export const message = "请先运行 ruying-code login 完成 GWM SSO 登录"

export class RuyingLoginRequiredError extends Schema.TaggedErrorClass<RuyingLoginRequiredError>()(
  "RuyingLoginRequiredError",
  { message: Schema.String },
) {}

export const requireRuyingLogin = Effect.fn("Auth.requireRuyingLogin")(function* () {
  const auth = yield* Auth.Service
  const config = yield* Config.Service
  const [credential, current] = yield* Effect.all([auth.get("ruying").pipe(Effect.orDie), config.get()])
  const marker = current.provider?.ruying?.options?.ruyingUser
  if (
    credential?.type === "api" &&
    credential.key &&
    typeof marker === "object" &&
    marker !== null &&
    !Array.isArray(marker)
  ) {
    return
  }
  return yield* new RuyingLoginRequiredError({ message })
})

export * as RuyingGate from "./ruying-gate"
