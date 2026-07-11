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

test("behaviorally rejects remote and public share URLs before file access", async () => {
  const module = await import("../../src/cli/cmd/import")
  expect("requireLocalImportPath" in module).toBe(true)
  const requireLocalImportPath = module.requireLocalImportPath as (value: string) => string

  expect(() => requireLocalImportPath("https://example.test/share/abc")).toThrow("Remote URL and share imports")
  expect(() => requireLocalImportPath("ssh://example.test/session.json")).toThrow("Remote URL and share imports")
  expect(requireLocalImportPath("./session.json")).toBe("./session.json")
  expect(requireLocalImportPath("C:\\sessions\\session.json")).toBe("C:\\sessions\\session.json")
})
