import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import type { Database } from "bun:sqlite"
import { Option, Schema } from "effect"
import type { MarketDatabase } from "./database"
import { randomSecret, type MarketSecurity, type Principal, SkillMarketSecurityError } from "./security"
import type { SkillHubImportStore } from "./skillhub-import-store"

interface SkillHubImportAdminOptions {
  readonly database: MarketDatabase
  readonly security: MarketSecurity
  readonly imports: SkillHubImportStore
  readonly now?: () => number
}

export interface SkillHubImportAdmin {
  readonly status: (principal: Principal) => SkillMarketControl.SkillHubImportProgress
  readonly command: (principal: Principal, input: unknown) => SkillMarketControl.SkillHubImportProgress
}

export function createSkillHubImportAdmin(options: SkillHubImportAdminOptions): SkillHubImportAdmin {
  const now = options.now ?? Date.now
  return {
    status(principal) {
      options.security.requireAdmin(principal)
      return options.imports.progress()
    },
    command(principal, input) {
      options.security.requireAdmin(principal)
      const decoded = Schema.decodeUnknownOption(SkillMarketControl.SkillHubImportCommandInput)(input)
      if (Option.isNone(decoded))
        throw new SkillMarketSecurityError("invalid-request", "SkillHub import command is invalid")
      return options.database.transaction((connection) => {
        const activeBefore = options.imports.activeGenerationIDInTransaction(connection)
        if (decoded.value.command !== "retry-rejected" && !activeBefore)
          throw new SkillMarketSecurityError("invalid-request", "invalid SkillHub import: no active generation")
        const before = options.imports.progressInTransaction(connection)
        const transition = options.imports.commandTransitionInTransaction(connection, decoded.value)
        if (decoded.value.command === "retry-rejected" && transition.retriedRejected.length === 0)
          throw new SkillMarketSecurityError("invalid-request", "invalid SkillHub rejected-item retry")
        const activeAfter = options.imports.activeGenerationIDInTransaction(connection)
        if (!activeAfter)
          throw new SkillMarketSecurityError("invalid-request", "invalid SkillHub import: no active generation")
        insertAudit(connection, {
          actorEmployeeID: principal.session.user.employeeID,
          action: auditAction(decoded.value.command),
          objectID: activeAfter,
          before: {
            counts: counts(before),
            ...(transition.retriedRejected.length > 0 ? { retriedRejected: transition.retriedRejected } : {}),
          },
          after: { counts: counts(transition.progress) },
          now: now(),
        })
        return transition.progress
      })
    },
  }
}

function auditAction(command: SkillMarketControl.SkillHubImportCommand): SkillMarketControl.AuditAction {
  if (command === "pause") return "skillhub-import-paused"
  if (command === "resume") return "skillhub-import-resumed"
  return "skillhub-import-retried"
}

function counts(progress: SkillMarketControl.SkillHubImportProgress) {
  return {
    upstreamTotal: progress.upstreamTotal,
    discovered: progress.discovered,
    pending: progress.pending,
    running: progress.running,
    mirrored: progress.mirrored,
    retryWait: progress.retryWait,
    rejected: progress.rejected,
    uploadedBytes: progress.uploadedBytes,
  }
}

function insertAudit(
  connection: Database,
  event: {
    readonly actorEmployeeID: string
    readonly action: SkillMarketControl.AuditAction
    readonly objectID: string
    readonly before: object
    readonly after: object
    readonly now: number
  },
) {
  connection.run(
    `INSERT INTO audit_events
      (id, actor_employee_id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, ?, ?, 'skillhub_import', ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      event.actorEmployeeID,
      event.action,
      event.objectID,
      JSON.stringify(event.before),
      JSON.stringify(event.after),
      `req_${randomSecret().slice(0, 16)}`,
      event.now,
    ],
  )
}
