import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAnnouncements } from "../src/announcements"
import { openDatabase } from "../src/database"
import type { Principal } from "../src/security"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("announcements", () => {
  test("publishes immutable announcements with newest-first history and an audit event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skill-market-announcements-"))
    directories.push(directory)
    const database = await openDatabase({
      databasePath: join(directory, "market.db"),
      migrationBackupDirectory: join(directory, "backups"),
    })
    database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
      ["E000001", "Admin User", 1, 1],
    )
    const clock = { value: Date.parse("2026-07-24T00:00:00.000Z") }
    const announcements = createAnnouncements({ database, now: () => clock.value })

    const first = announcements.publish(principal(), {
      title: "首个公告",
      summary: "首个公告摘要",
      content: "# 首个公告\n\n正文内容",
    })
    clock.value += 60_000
    const second = announcements.publish(principal(), {
      title: "第二个公告",
      summary: "第二个公告摘要",
      content: "第二个公告正文",
    })

    expect(announcements.list({ page: 1, limit: 1 })).toMatchObject({
      total: 2,
      page: 1,
      limit: 1,
      items: [{ id: second.id, title: "第二个公告" }],
    })
    expect(announcements.detail(first.id)).toEqual(first)
    expect(
      database.connection
        .query<{ action: string; object_type: string; object_id: string; actor_employee_id: string }, [string]>(
          "SELECT action, object_type, object_id, actor_employee_id FROM audit_events WHERE object_id = ?",
        )
        .get(second.id),
    ).toEqual({
      action: "announcement-published",
      object_type: "announcement",
      object_id: second.id,
      actor_employee_id: "E000001",
    })
    expect(() => database.connection.run("UPDATE announcements SET title = 'changed' WHERE id = ?", [first.id])).toThrow(
      "announcements are append-only",
    )
    database.close()
  })
})

function principal(): Principal {
  return {
    csrfHash: "",
    session: {
      user: { employeeID: "E000001", displayName: "Admin User" },
      roles: ["admin"],
      csrfToken: "_".repeat(43),
      createdAt: "2026-07-24T00:00:00.000Z",
      absoluteExpiresAt: "2026-07-24T12:00:00.000Z",
      idleExpiresAt: "2026-07-24T02:00:00.000Z",
    },
  }
}
