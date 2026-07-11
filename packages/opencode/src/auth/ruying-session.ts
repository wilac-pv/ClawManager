import { Brand } from "@opencode-ai/core/brand/brand"
import { Global } from "@opencode-ai/core/global"
import { Effect, Schema } from "effect"
import { Config } from "@/config/config"
import { ConfigPaths } from "@/config/paths"
import { errorMessage } from "@/util/error"
import { chmod, lstat, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Auth } from "."

export const getRuyingSessionStatus = Effect.fn("Auth.ruyingSessionStatus")(function* () {
  const auth = yield* Auth.Service
  const config = yield* Config.Service
  const [credential, current] = yield* Effect.all([
    auth.get(Brand.profile.providerID).pipe(Effect.orDie),
    config.get(),
  ])
  const marker = current.provider?.[Brand.profile.providerID]?.options?.ruyingUser
  if (
    credential?.type !== "api" ||
    !credential.key ||
    typeof marker !== "object" ||
    marker === null ||
    Array.isArray(marker)
  ) {
    return { loggedIn: false as const }
  }
  const value = marker as { employeeId?: unknown; displayName?: unknown; email?: unknown }
  return {
    loggedIn: true as const,
    user: {
      ...(typeof value.employeeId === "string" ? { employeeId: value.employeeId } : {}),
      ...(typeof value.displayName === "string" ? { displayName: value.displayName } : {}),
      ...(typeof value.email === "string" ? { email: value.email } : {}),
    },
  }
})

export class RuyingSessionLogoutError extends Schema.TaggedErrorClass<RuyingSessionLogoutError>()(
  "RuyingSessionLogoutError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

interface LogoutRuyingInput {
  prepareIdentity: () => Effect.Effect<Effect.Effect<void, RuyingSessionLogoutError>, RuyingSessionLogoutError>
  get: (providerID: string) => Effect.Effect<Auth.Info | undefined>
  remove: (providerID: string) => Effect.Effect<unknown>
  set: (providerID: string, info: Auth.Info) => Effect.Effect<unknown>
}

export const logoutRuying = Effect.fn("Auth.ruyingSessionLogoutTransaction")(function* (input: LogoutRuyingInput) {
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

export const logoutRuyingSession = Effect.fn("Auth.ruyingSessionLogout")(function* () {
  const auth = yield* Auth.Service
  yield* logoutRuying({
    prepareIdentity: () => prepareRuyingIdentityRemoval(globalConfigFile()),
    get: (providerID) => auth.get(providerID).pipe(Effect.orDie),
    remove: (providerID) => auth.remove(providerID).pipe(Effect.orDie),
    set: (providerID, info) => auth.set(providerID, info).pipe(Effect.orDie),
  })
})

export function globalConfigFile(directory = Global.Path.config) {
  const candidates = [
    ...ConfigPaths.globalConfigNames.toReversed().flatMap((name) => [`${name}.jsonc`, `${name}.json`]),
    "config.json",
  ].map((name) => join(directory, name))
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

export function prepareRuyingIdentityRemoval(file: string) {
  return Effect.tryPromise({
    try: async () => {
      const target = await resolveExistingConfig(file)
      if (!target) return Effect.void
      await identityEdit(target)
      return Effect.tryPromise({
        try: () => removeRuyingIdentity(target),
        catch: (cause) =>
          new RuyingSessionLogoutError({
            message: `Failed to update Ruying identity config: ${errorMessage(cause)}`,
            cause,
          }),
      })
    },
    catch: (cause) =>
      new RuyingSessionLogoutError({
        message: `Failed to read Ruying identity config: ${errorMessage(cause)}`,
        cause,
      }),
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

export * as RuyingSession from "./ruying-session"
