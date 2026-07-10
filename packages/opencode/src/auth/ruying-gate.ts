import { Effect } from "effect"
import type { Auth } from "."

const message = "请先运行 ruying-code login 完成 GWM SSO 登录"

export class RuyingLoginRequiredError extends Error {
  readonly providerID = "ruying"

  constructor() {
    super(message)
    this.name = "RuyingLoginRequiredError"
  }
}

export async function requireRuyingLogin(auth: Auth.Info | undefined) {
  const user = auth?.type === "api" ? auth.metadata : undefined
  if (auth?.type === "api" && auth.key && user?.employeeId) return
  throw new RuyingLoginRequiredError()
}

export const requireRuyingLoginEffect = Effect.fn("Auth.requireRuyingLogin")((auth: Auth.Info | undefined) =>
  Effect.tryPromise({
    try: () => requireRuyingLogin(auth),
    catch: () => new RuyingLoginRequiredError(),
  }),
)

export * as RuyingGate from "./ruying-gate"
