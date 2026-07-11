import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { CliError, effectCmd } from "../effect-cmd"
import { ShareRevocationQuarantine } from "@/share/quarantine"

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

const ShareQuarantineListCommand = effectCmd({
  command: "list",
  describe: "list quarantined share IDs without displaying revocation secrets",
  instance: false,
  handler: Effect.fn("Cli.db.shareQuarantine.list")(function* () {
    const quarantine = yield* ShareRevocationQuarantine.Service
    const rows = yield* quarantine.list()
    for (const row of rows) console.log(`${row.id}\t${row.sessionID}\t${new Date(row.timeCreated).toISOString()}`)
  }),
})

const ShareQuarantineExportCommand = effectCmd({
  command: "export <file>",
  describe: "export revocation material to a new local file with mode 0600",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.positional("file", { type: "string", demandOption: true, describe: "new local export file" }),
  handler: Effect.fn("Cli.db.shareQuarantine.export")(function* (args: { file: string }) {
    const quarantine = yield* ShareRevocationQuarantine.Service
    const count = yield* quarantine
      .exportTo(args.file)
      .pipe(Effect.mapError((error) => new CliError({ message: `Failed to export quarantine: ${String(error)}` })))
    console.log(`Exported ${count} quarantined share revocation record(s) to ${args.file}`)
  }),
})

const ShareQuarantineCompleteCommand = effectCmd({
  command: "complete <id>",
  describe: "remove one local record after manual remote revocation is confirmed",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { type: "string", demandOption: true, describe: "public share ID" })
      .option("confirmed", {
        type: "boolean",
        default: false,
        describe: "confirm the share was revoked manually on the remote service",
      }),
  handler: Effect.fn("Cli.db.shareQuarantine.complete")(function* (args: { id: string; confirmed: boolean }) {
    if (!args.confirmed) {
      return yield* new CliError({ message: "Pass --confirmed only after manual remote revocation succeeds." })
    }
    const quarantine = yield* ShareRevocationQuarantine.Service
    const removed = yield* quarantine
      .complete(args.id, args.confirmed)
      .pipe(Effect.mapError((error) => new CliError({ message: error.message })))
    console.log(removed ? `Removed local quarantine record ${args.id}` : `No quarantine record found for ${args.id}`)
  }),
})

const ShareQuarantineCommand = effectCmd({
  command: "share-quarantine",
  describe: "secure local workflow for manual public share revocation",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(ShareQuarantineListCommand)
      .command(ShareQuarantineExportCommand)
      .command(ShareQuarantineCompleteCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.db.shareQuarantine")(function* () {}),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).command(ShareQuarantineCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
