import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { canReadRestricted } from "./audience"
import type { Connection, MarketDatabase } from "./store"
import type { Principal } from "./security"
import { SkillMarketSecurityError } from "./security"

interface FavoriteRow {
  readonly source: SkillMarket.Source
  readonly skill_id: string
  readonly created_at: number
}

export function createFavorites(options: { readonly database: MarketDatabase; readonly now?: () => number }) {
  return {
    async list(principal: Principal) {
      const rows = await options.database.read(async (connection) => {
        const all = await connection.all<FavoriteRow>(
          `SELECT source, skill_id, created_at
               FROM skill_favorites
               WHERE employee_id = ?
               ORDER BY created_at DESC, source, skill_id`,
          [principal.session.user.employeeID],
        )
        const visible: FavoriteRow[] = []
        for (const row of all) {
          if (row.source !== "restricted" || (await canReadRestricted(connection, principal, row.skill_id)))
            visible.push(row)
        }
        return visible
      })
      return rows.map(favorite)
    },

    async add(principal: Principal, key: SkillMarket.SkillKey) {
      const now = options.now?.() ?? Date.now()
      await options.database.transaction(async (connection) => {
        if (key.source === "restricted" && !(await canReadRestricted(connection, principal, key.id))) throw restrictedNotFound()
        await connection.run(
          `INSERT INTO skill_favorites (employee_id, source, skill_id, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(employee_id, source, skill_id) DO NOTHING`,
          [principal.session.user.employeeID, key.source, key.id, now],
        )
      })
      const row = await options.database.read((connection) =>
        connection.get<FavoriteRow>(
          "SELECT source, skill_id, created_at FROM skill_favorites WHERE employee_id = ? AND source = ? AND skill_id = ?",
          [principal.session.user.employeeID, key.source, key.id],
        ),
      )
      if (!row) throw new SkillMarketSecurityError("not-found", "favorite was not found")
      return favorite(row)
    },

    async remove(principal: Principal, key: SkillMarket.SkillKey) {
      await options.database.transaction((connection) =>
        connection.run("DELETE FROM skill_favorites WHERE employee_id = ? AND source = ? AND skill_id = ?", [
          principal.session.user.employeeID,
          key.source,
          key.id,
        ]),
      )
    },
  }
}

export type Favorites = ReturnType<typeof createFavorites>

function favorite(row: FavoriteRow) {
  return Schema.decodeUnknownSync(SkillMarket.Favorite)({
    source: row.source,
    id: row.skill_id,
    createdAt: new Date(row.created_at).toISOString(),
  })
}

function restrictedNotFound() {
  return new SkillMarketSecurityError("not-found", "restricted publication was not found")
}
