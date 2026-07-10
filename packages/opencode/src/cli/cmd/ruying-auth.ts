import { Brand } from "@opencode-ai/core/brand/brand"
import { Effect } from "effect"
import { chmod, lstat, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { errorMessage } from "@/util/error"
import { Auth } from "../../auth"
import { CliError, effectCmd } from "../effect-cmd"
import { loginProvider } from "./providers"

export function runLogin(input: { loginProvider: (providerID: string) => Promise<void> }) {
  return input.loginProvider(Brand.profile.providerID)
}

export function runLogout(input: { remove: (providerID: string) => Promise<void> }) {
  return input.remove(Brand.profile.providerID)
}

interface LogoutRuyingInput {
  prepareIdentity: () => Effect.Effect<Effect.Effect<void, CliError>, CliError>
  get: (providerID: string) => Effect.Effect<Auth.Info | undefined>
  remove: (providerID: string) => Effect.Effect<unknown>
  set: (providerID: string, info: Auth.Info) => Effect.Effect<unknown>
}

export const logoutRuying = Effect.fn("Cli.ruying.logoutProvider")(function* (input: LogoutRuyingInput) {
  const publishIdentity = yield* input.prepareIdentity()
  const previous = yield* input.get(Brand.profile.providerID)
  yield* input.remove(Brand.profile.providerID)
  yield* publishIdentity.pipe(
    Effect.catch((error) => {
      if (!previous) return Effect.fail(error)
      return input.set(Brand.profile.providerID, previous).pipe(Effect.andThen(Effect.fail(error)))
    }),
  )
})

export function prepareRuyingIdentityRemoval(file: string) {
  return Effect.tryPromise({
    try: async () => {
      const target = await resolveExistingConfig(file)
      if (!target) return Effect.void
      await identityEdit(target)
      return Effect.tryPromise({
        try: () => removeRuyingIdentity(target),
        catch: (cause) =>
          new CliError({ message: `Failed to update Ruying identity config: ${errorMessage(cause)}` }),
      })
    },
    catch: (cause) => new CliError({ message: `Failed to read Ruying identity config: ${errorMessage(cause)}` }),
  })
}

export async function removeRuyingIdentity(file: string) {
  const target = await resolveExistingConfig(file)
  if (!target) return
  const edit = await identityEdit(target)
  if (!edit) return
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, edit.output, { encoding: "utf8", flag: "wx", mode: edit.mode })
    .then(() => chmod(temporary, edit.mode))
    .then(() => rename(temporary, target))
    .catch(async (error) => {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    })
}

async function resolveExistingConfig(file: string) {
  const requested = resolve(file)
  try {
    await lstat(requested)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  return realpath(requested)
}

async function identityEdit(file: string) {
  const source = await Bun.file(file).text()
  const errors: ParseError[] = []
  const config: unknown = parse(source, errors, { allowTrailingComma: true })
  if (errors.length || typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`Invalid JSONC config at ${file}`)
  }
  const edits = modify(source, ["provider", Brand.profile.providerID, "options", "ruyingUser"], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  if (!edits.length) return
  return {
    output: applyEdits(source, edits),
    mode: (await stat(file)).mode & 0o777,
  }
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
    const { globalConfigFile } = yield* Effect.promise(() => import("../../plugin/ruying"))
    yield* logoutRuying({
      prepareIdentity: () => prepareRuyingIdentityRemoval(globalConfigFile()),
      get: (providerID) => auth.get(providerID).pipe(Effect.orDie),
      remove: (providerID) => auth.remove(providerID).pipe(Effect.orDie),
      set: (providerID, info) => auth.set(providerID, info).pipe(Effect.orDie),
    })
  }),
})
