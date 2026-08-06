import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { createExpertPackages } from "../src/expert-packages"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("expert packages", () => {
  test("synchronizes published upstream packages and serves local search and detail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skill-market-expert-packages-"))
    directories.push(directory)
    const database = await openDatabase({
      databasePath: join(directory, "market.db"),
      migrationBackupDirectory: join(directory, "backups"),
    })
    const responses = [
      {
        skillSets: [
          expertPackage("tech-test-automation", "自动化测试", "tech", ["tdd", "e2e"]),
          expertPackage("finance-risk", "风控评估", "finance", ["risk"]),
          { ...expertPackage("draft", "草稿", "tech", []), published: 0 },
        ],
        total: 3,
      },
      {
        skillSets: [expertPackage("finance-risk", "风控评估", "finance", ["risk"])],
        total: 1,
      },
    ]
    const packages = createExpertPackages({
      database,
      baseUrl: "https://api.skillhub.cn",
      now: () => Date.parse("2026-07-24T00:00:00.000Z"),
      fetcher: async () => Response.json(responses.shift()),
    })

    expect(await packages.refresh()).toBe(2)
    expect((await packages.list({ query: "测试", page: 1, limit: 30 })).items.map((entry) => entry.slug)).toEqual([
      "tech-test-automation",
    ])
    expect((await packages.list({ scene: "finance", page: 1, limit: 30 })).total).toBe(1)
    expect(await packages.detail("tech-test-automation")).toMatchObject({
      slug: "tech-test-automation",
      content: "# 自动化测试工作流\n",
      skillSlugs: ["tdd", "e2e"],
    })

    expect(await packages.refresh()).toBe(1)
    expect(await packages.detail("tech-test-automation")).toBeUndefined()
    await database.close()
  })
})

function expertPackage(
  slug: string,
  displayName: string,
  scene: "tech" | "finance",
  skillSlugs: string[],
) {
  return {
    slug,
    displayName,
    summary: `${displayName}完整工作流`,
    scene,
    subScene: "workflow",
    content: `---\nname: ${slug}\n---\n# ${displayName}工作流\n`,
    skillSlugs,
    skillCount: skillSlugs.length,
    published: 1,
    updatedAt: Date.parse("2026-07-23T00:00:00.000Z"),
  }
}
