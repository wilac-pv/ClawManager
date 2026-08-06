import { Database } from "bun:sqlite"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { SqliteDatabase } from "../src/database"
import type { Principal } from "../src/security"
import { SkillMarketSecurityError } from "../src/security"
import { createSubmissions } from "../src/submissions"

const [databasePath, submissionID, expectedVersion, target, idempotencyKey, barrierPath] = process.argv.slice(2)
if (!databasePath || !submissionID || !expectedVersion || !target || !idempotencyKey || !barrierPath)
  throw new Error("missing audience-change race worker argument")
if (target !== "personal" && target !== "department") throw new Error("invalid audience-change race target")

while (!(await Bun.file(barrierPath).exists())) await Bun.sleep(1)

const database = new SqliteDatabase(new Database(databasePath, { readwrite: true }))
await database.transaction(async (c) => c.run("PRAGMA busy_timeout = 5000"))
await database.transaction(async (c) => c.run("PRAGMA foreign_keys = ON"))
const principal = {
  session: {
    user: {
      employeeID: "alice",
      displayName: "ALICE",
      email: "alice@example.com",
      department: { id: "engineering", name: "Engineering" },
    },
    roles: [],
    csrfToken: "race-csrf-token",
    createdAt: "2026-07-15T00:00:00.000Z",
    absoluteExpiresAt: "2026-07-15T12:00:00.000Z",
    idleExpiresAt: "2026-07-15T02:00:00.000Z",
  },
  csrfHash: "race-csrf-hash",
} satisfies Principal
const input =
  target === "personal"
    ? { idempotencyKey, expectedVersion: Number(expectedVersion), target: "personal" as const }
    : {
        idempotencyKey,
        expectedVersion: Number(expectedVersion),
        target: "department" as const,
        audience: { scope: "department" as const },
      }
const result = await createSubmissions({ database }).changeAudience(principal, submissionID, input).then(
  () => ({ status: "fulfilled" as const }),
  (error: unknown) => {
    if (error instanceof SkillMarketSecurityError)
      return { status: "rejected" as const, code: error.code satisfies SkillMarketControl.ProblemCode }
    throw error
  },
)
console.log(JSON.stringify(result))
await database.close()
