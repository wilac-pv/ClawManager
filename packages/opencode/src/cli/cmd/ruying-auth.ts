import { Brand } from "@opencode-ai/core/brand/brand"
import { Effect } from "effect"
import { applyEdits, modify } from "jsonc-parser"
import { Auth } from "../../auth"
import { effectCmd } from "../effect-cmd"
import { loginProvider } from "./providers"

export function runLogin(input: { loginProvider: (providerID: string) => Promise<void> }) {
  return input.loginProvider(Brand.profile.providerID)
}

export function runLogout(input: { remove: (providerID: string) => Promise<void> }) {
  return input.remove(Brand.profile.providerID)
}

export async function removeRuyingIdentity(file: string) {
  if (!(await Bun.file(file).exists())) return
  const source = await Bun.file(file).text()
  const edits = modify(source, ["provider", Brand.profile.providerID, "options", "ruyingUser"], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  if (!edits.length) return
  await Bun.write(file, applyEdits(source, edits))
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
    const auth = yield* Auth.Service
    yield* Effect.orDie(auth.remove(Brand.profile.providerID))
    const { globalConfigFile } = yield* Effect.promise(() => import("../../plugin/ruying"))
    yield* Effect.promise(() => removeRuyingIdentity(globalConfigFile()))
  }),
})
