import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { createFavorites } from "../src/favorites"
import type { Principal } from "../src/security"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("favorites", () => {
  test("stores idempotent per-user favorites and removes them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skill-market-favorites-"))
    directories.push(directory)
    const database = await openDatabase({
      databasePath: join(directory, "market.db"),
      migrationBackupDirectory: join(directory, "backups"),
    })
    database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
      ["E000001", "User One", 1, 1, "E000002", "User Two", 1, 1],
    )
    const favorites = createFavorites({
      database,
      now: () => Date.parse("2026-07-24T00:00:00.000Z"),
    })

    favorites.add(principal("E000001"), { source: "skillhub", id: "code-review" })
    favorites.add(principal("E000001"), { source: "skillhub", id: "code-review" })
    favorites.add(principal("E000002"), { source: "enterprise", id: "internal-docs" })
    expect(favorites.list(principal("E000001"))).toEqual([
      {
        source: "skillhub",
        id: "code-review",
        createdAt: "2026-07-24T00:00:00.000Z",
      },
    ])

    favorites.remove(principal("E000001"), { source: "skillhub", id: "code-review" })
    expect(favorites.list(principal("E000001"))).toEqual([])
    expect(favorites.list(principal("E000002"))).toHaveLength(1)
    database.close()
  })
})

function principal(employeeID: string): Principal {
  return {
    csrfHash: "",
    session: {
      user: { employeeID, displayName: employeeID },
      roles: [],
      csrfToken: "_".repeat(43),
      createdAt: "2026-07-24T00:00:00.000Z",
      absoluteExpiresAt: "2026-07-24T12:00:00.000Z",
      idleExpiresAt: "2026-07-24T02:00:00.000Z",
    },
  }
}
