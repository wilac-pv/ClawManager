import { expect, test } from "bun:test"

test("keeps local-file import registered without URL or share transport", async () => {
  const source = await Bun.file(new URL("../../src/cli/cmd/import.ts", import.meta.url)).text()
  const entry = await Bun.file(new URL("../../src/index.ts", import.meta.url)).text()

  expect(entry).toContain("ImportCommand")
  expect(source).toContain('describe: "import session data from a local JSON file"')
  expect(source).toContain("Remote URL and share imports are disabled")
  expect(source).not.toContain("ShareNext")
  expect(source).not.toContain("fetch(")
  expect(source).not.toContain("parseShareUrl")
})
