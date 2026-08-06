import { SkillMarket } from "@opencode-ai/schema/skill-market"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import type { MarketDatabase } from "./store"
import { randomSecret, type Principal } from "./security"

interface AnnouncementRow {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly content: string
  readonly published_at: number
}

export function createAnnouncements(options: { readonly database: MarketDatabase; readonly now?: () => number }) {
  return {
    list(query: { readonly page: number; readonly limit: number }) {
      return options.database.read(async (connection) => {
        const total = (await connection.get<{ count: number }>("SELECT count(*) AS count FROM announcements"))?.count
        const rows = await connection.all<AnnouncementRow>(
          `SELECT id, title, summary, content, published_at
             FROM announcements
             ORDER BY published_at DESC, id DESC
             LIMIT ? OFFSET ?`,
          [query.limit, (query.page - 1) * query.limit],
        )
        return Schema.decodeUnknownSync(SkillMarket.AnnouncementPage)({
          total,
          page: query.page,
          limit: query.limit,
          items: rows.map(summary),
        })
      })
    },

    detail(announcementID: string) {
      const row = options.database.read(async (connection) =>
        connection.get<AnnouncementRow>(
          "SELECT id, title, summary, content, published_at FROM announcements WHERE id = ?",
          [announcementID],
        ),
      )
      return row.then((value) => (value ? detail(value) : undefined))
    },

    publish(principal: Principal, input: SkillMarketControl.AnnouncementCreateInput) {
      const now = options.now?.() ?? Date.now()
      const announcementID = `ann_${randomSecret()}`
      options.database.transaction(async (connection) => {
        await connection.run(
          `INSERT INTO announcements
            (id, title, summary, content, published_by_employee_id, published_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [announcementID, input.title, input.summary, input.content, principal.session.user.employeeID, now],
        )
        await connection.run(
          `INSERT INTO audit_events
            (id, actor_employee_id, action, object_type, object_id, after_json, request_id, created_at)
           VALUES (?, ?, 'announcement-published', 'announcement', ?, ?, ?, ?)`,
          [
            `aud_${randomSecret()}`,
            principal.session.user.employeeID,
            announcementID,
            JSON.stringify({ title: input.title, summary: input.summary }),
            `req_${randomSecret()}`,
            now,
          ],
        )
      })
      return Schema.decodeUnknownSync(SkillMarket.AnnouncementDetail)({
        id: announcementID,
        title: input.title,
        summary: input.summary,
        content: input.content,
        publishedAt: new Date(now).toISOString(),
      })
    },
  }
}

export type Announcements = ReturnType<typeof createAnnouncements>

function summary(row: AnnouncementRow) {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    publishedAt: new Date(row.published_at).toISOString(),
  }
}

function detail(row: AnnouncementRow) {
  return Schema.decodeUnknownSync(SkillMarket.AnnouncementDetail)({
    ...summary(row),
    content: row.content,
  })
}
