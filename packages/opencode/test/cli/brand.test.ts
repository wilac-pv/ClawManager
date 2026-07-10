import { expect, test } from "bun:test"
import { ConfigPaths } from "../../src/config/paths"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

test("publishes both command names", async () => {
  const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
  expect(pkg.bin).toEqual({ "ruying-code": "./bin/opencode", opencode: "./bin/opencode" })
})

test("orders legacy config before ruying config so ruying wins merge precedence", () => {
  expect(ConfigPaths.projectDirectoryNames).toEqual([".opencode", ".ruying-code"])
  expect(ConfigPaths.globalConfigNames).toEqual(["opencode", "ruying-code"])
})

cliIt.live(
  "uses the branded command name in help",
  ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--help"])
      opencode.expectExit(result, 0)
      expect(result.stderr).toContain("ruying-code completion")
    }),
  60_000,
)
