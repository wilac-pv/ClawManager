import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { CliError, effectCmd } from "../effect-cmd"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)
type ExportData = { info: SDKSession; messages: Array<{ info: Message; parts: Part[] }> }

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from a local JSON file",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "path to a local JSON file",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* runImport(args.file, ctx)
  }),
})

export function isNetworkImportPath(file: string, platform: NodeJS.Platform = process.platform) {
  const windowsPrefix = /^(?:\\\\|\/\/|\\\/|\/\\)/
  if (platform === "win32" && windowsPrefix.test(file)) {
    const separator = file.startsWith("\\\\") ? "\\" : file.startsWith("//") ? "/" : undefined
    if (!separator) return true
    if (file.includes(separator === "\\" ? "/" : "\\")) return true
    const escaped = separator === "\\" ? "\\\\" : "/"
    const drive = new RegExp(`^${escaped}${escaped}\\?${escaped}[a-z]:${escaped}(?!${escaped})`, "i")
    const volume = new RegExp(
      `^${escaped}${escaped}\\?${escaped}Volume\\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\}${escaped}`,
      "i",
    )
    return !drive.test(file) && !volume.test(file)
  }
  if (platform === "win32" && /^[a-z]:[\\/]/i.test(file)) {
    const separator = file[2]
    const rest = file.slice(2)
    if (rest.startsWith("//") || rest.startsWith("\\\\")) return true
    return rest.includes(separator === "\\" ? "/" : "\\")
  }
  const normalized = file.replaceAll("\\", "/")
  return file.startsWith("\\\\") && /^\/\//.test(normalized)
}

export function requireLocalImportPath(file: string) {
  if (!/^[a-z]:[\\/]/i.test(file) && /^[a-z][a-z0-9+.-]*:\/\//i.test(file)) {
    throw new CliError({ message: "Remote URL and share imports are disabled; provide a local JSON file." })
  }
  if (isNetworkImportPath(file)) {
    throw new CliError({ message: "Network-share imports are disabled; provide a local filesystem path." })
  }
  return file
}

const runImport = Effect.fn("Cli.import.body")(function* (file: string, ctx: InstanceContext) {
  const localFile = requireLocalImportPath(file)

  const fs = yield* FSUtil.Service
  const { db } = yield* Database.Service
  const exportData = (yield* fs.readJson(localFile).pipe(Effect.orElseSucceed(() => undefined))) as
    | ExportData
    | undefined
  if (!exportData) {
    process.stdout.write(`File not found: ${localFile}${EOL}`)
    return
  }

  const info = Schema.decodeUnknownSync(Session.Info)({
    ...exportData.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
  }) as Session.Info
  const row = Session.toRow(info)
  yield* db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: { project_id: row.project_id, directory: row.directory, path: row.path },
    })
    .run()
    .pipe(Effect.orDie)

  for (const msg of exportData.messages) {
    const msgInfo = decodeMessageInfo(msg.info) as SessionV1.Info
    const { id, sessionID: _, ...msgData } = msgInfo
    yield* db
      .insert(MessageTable)
      .values({
        id,
        session_id: row.id,
        time_created: msgInfo.time?.created ?? Date.now(),
        data: msgData as never,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    for (const part of msg.parts) {
      const partInfo = decodePart(part) as SessionV1.Part
      const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
      yield* db
        .insert(PartTable)
        .values({ id: partId, message_id: messageID, session_id: row.id, data: partData })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  }

  process.stdout.write(`Imported session: ${exportData.info.id}${EOL}`)
})
