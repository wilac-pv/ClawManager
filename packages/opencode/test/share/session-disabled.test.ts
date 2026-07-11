import { describe, expect, test } from "bun:test"
import { fromRow } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ProjectV2 } from "@opencode-ai/core/project"

describe("OEM sharing boundary", () => {
  test("hard-disables sharing independently of inherited configuration", async () => {
    const source = await Bun.file(new URL("../../src/share/session.ts", import.meta.url)).text()

    expect(source).toContain("Public session sharing is not available")
    expect(source).not.toContain("flags.autoShare")
    expect(source).not.toContain('conf.share === "auto"')
    expect(source).not.toContain("shareNext.create")
    expect(source).toContain("Public share revocation material remains quarantined locally")
    expect(source).toContain("Do not paste the share secret into chat or logs")

    const config = await Bun.file(new URL("../../src/config/config.ts", import.meta.url)).text()
    expect(config).toContain('result.share = "disabled"')

    const entry = await Bun.file(new URL("../../src/index.ts", import.meta.url)).text()
    expect(entry).not.toContain("GithubCommand")
    expect(entry).not.toContain("ConsoleCommand")
    expect(entry).toContain("ImportCommand")

    const run = await Bun.file(new URL("../../src/cli/cmd/run.ts", import.meta.url)).text()
    expect(run).not.toContain('option("share"')
    expect(run).not.toContain("sdk.session.share")
  })

  test("does not project a migrated public share URL", () => {
    const info = fromRow({
      id: SessionID.make("ses_test"),
      slug: "test",
      project_id: ProjectV2.ID.make("global"),
      workspace_id: null,
      directory: "/tmp",
      path: null,
      parent_id: null,
      title: "test",
      agent: null,
      model: null,
      version: "1",
      share_url: "https://opncd.ai/share/secret",
      summary_additions: null,
      summary_deletions: null,
      summary_files: null,
      summary_diffs: null,
      metadata: null,
      revert: null,
      permission: null,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      time_created: 0,
      time_updated: 0,
      time_compacting: null,
      time_archived: null,
    })

    expect(info.share).toBeUndefined()
  })
})
