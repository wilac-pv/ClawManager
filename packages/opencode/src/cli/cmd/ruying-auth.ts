import { Brand } from "@opencode-ai/core/brand/brand"
import { Effect } from "effect"
import { logoutRuyingSession } from "@/auth/ruying-session"
import { CliError, effectCmd } from "../effect-cmd"
import { loginProvider } from "./providers"

export function runLogin(input: { loginProvider: (providerID: string) => Promise<void> }) {
  return input.loginProvider(Brand.profile.providerID)
}

export function runLogout(input: { remove: (providerID: string) => Promise<void> }) {
  return input.remove(Brand.profile.providerID)
}

export const LoginCommand = effectCmd({
  command: "login",
  describe: "使用 GWM SSO 登录如影 Code",
  handler: Effect.fn("Cli.ruying.login")(function* () {
    yield* loginProvider(Brand.profile.providerID)
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout",
  describe: "退出如影 Code",
  instance: false,
  handler: Effect.fn("Cli.ruying.logout")(function* () {
    yield* logoutRuyingSession().pipe(Effect.mapError((error) => new CliError({ message: error.message })))
  }),
})
