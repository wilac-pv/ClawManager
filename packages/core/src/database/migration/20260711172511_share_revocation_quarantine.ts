import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260711172511_share_revocation_quarantine",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`share_revocation_quarantine\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        INSERT OR IGNORE INTO \`share_revocation_quarantine\`
          (\`id\`, \`session_id\`, \`secret\`, \`url\`, \`time_created\`, \`time_updated\`)
        SELECT \`id\`, \`session_id\`, \`secret\`, \`url\`, \`time_created\`, \`time_updated\`
        FROM \`session_share\`;
      `)
      yield* tx.run("DELETE FROM `session_share`;")
    })
  },
} satisfies DatabaseMigration.Migration
