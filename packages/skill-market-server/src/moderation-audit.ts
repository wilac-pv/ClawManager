import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import type { Connection } from "./store"
import { randomSecret } from "./security"

export async function insertAudit(
  connection: Connection,
  event: {
    readonly actorEmployeeID: string
    readonly action: SkillMarketControl.AuditAction
    readonly objectType: SkillMarketControl.AuditObjectType
    readonly objectID: string
    readonly before?: object
    readonly after?: object
    readonly now: number
  },
) {
  await connection.run(
    `INSERT INTO audit_events
      (id, actor_employee_id, action, object_type, object_id, before_json, after_json, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `aud_${randomSecret()}`,
      event.actorEmployeeID,
      event.action,
      event.objectType,
      event.objectID,
      event.before ? JSON.stringify(event.before) : null,
      event.after ? JSON.stringify(event.after) : null,
      `req_${randomSecret()}`,
      event.now,
    ],
  )
}

export async function enqueueCatalogRebuild(connection: Connection, now: number) {
  const active = (
    await connection.get<{ count: number }>(
      "SELECT count(*) AS count FROM publish_jobs WHERE kind = 'catalog_rebuild' AND status = 'pending'",
    )
  )!.count
  if (active > 0) return
  await connection.run(
    `INSERT INTO publish_jobs (id, kind, status, attempts, created_at, updated_at)
     VALUES (?, 'catalog_rebuild', 'pending', 0, ?, ?)`,
    [`job_${randomSecret()}`, now, now],
  )
}
