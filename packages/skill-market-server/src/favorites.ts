import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import type { MarketDatabase } from "./database"
import type { Principal } from "./security"

interface FavoriteRow {
  readonly source: SkillMarket.Source
  readonly skill_id: string
  readonly created_at: number
}

export function createFavorites(options: { readonly database: MarketDatabase; readonly now?: () => number }) {
  return {
    list(principal: Principal) {
      return options.database
        .read((connection) =>
          connection
            .query<FavoriteRow, [string]>(
              `SELECT source, skill_id, created_at
               FROM skill_favorites
               WHERE employee_id = ?
               ORDER BY created_at DESC, source, skill_id`,
            )
            .all(principal.session.user.employeeID),
        )
        .map(favorite)
    },

    add(principal: Principal, key: SkillMarket.SkillKey) {
      const now = options.now?.() ?? Date.now()
      options.database.transaction((connection) =>
        connection.run(
          `INSERT INTO skill_favorites (employee_id, source, skill_id, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(employee_id, source, skill_id) DO NOTHING`,
          [principal.session.user.employeeID, key.source, key.id, now],
        ),
      )
      const row = options.database.read((connection) =>
        connection
          .query<FavoriteRow, [string, SkillMarket.Source, string]>(
            "SELECT source, skill_id, created_at FROM skill_favorites WHERE employee_id = ? AND source = ? AND skill_id = ?",
          )
          .get(principal.session.user.employeeID, key.source, key.id),
      )!
      return favorite(row)
    },

    remove(principal: Principal, key: SkillMarket.SkillKey) {
      options.database.transaction((connection) =>
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
