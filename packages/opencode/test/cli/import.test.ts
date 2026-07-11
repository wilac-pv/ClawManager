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
  const body = source.slice(source.indexOf('Effect.fn("Cli.import.body")'))
  expect(body.indexOf("requireLocalImportPath")).toBeLessThan(body.indexOf("FSUtil.Service"))
})

test("rejects only remote and Windows network paths before filesystem service access", async () => {
  const module = await import("../../src/cli/cmd/import")
  expect("requireLocalImportPath" in module).toBe(true)
  const requireLocalImportPath = module.requireLocalImportPath as (value: string) => string
  const isNetworkImportPath = (module as unknown as {
    isNetworkImportPath?: (value: string, platform: NodeJS.Platform) => boolean
  }).isNetworkImportPath

  expect(isNetworkImportPath).toBeTypeOf("function")
  if (!isNetworkImportPath) return
  expect(isNetworkImportPath("//server/share/session.json", "win32")).toBe(true)
  expect(isNetworkImportPath("//?/UNC/server/share/session.json", "win32")).toBe(true)
  expect(isNetworkImportPath("//./UNC/server/share/session.json", "win32")).toBe(true)
  expect(isNetworkImportPath("//server\\share/session.json", "win32")).toBe(true)
  expect(isNetworkImportPath("//?/UNC\\server/share/session.json", "win32")).toBe(true)
  expect(isNetworkImportPath("//./UNC\\server/share/session.json", "win32")).toBe(true)
  expect(isNetworkImportPath("\\\\?\\UNC/server\\share/session.json", "linux")).toBe(true)
  expect(isNetworkImportPath("//tmp/session.json", "linux")).toBe(false)
  expect(isNetworkImportPath("//server/share/session.json", "darwin")).toBe(false)
  expect(isNetworkImportPath("//?/C:/sessions/session.json", "win32")).toBe(false)
  expect(isNetworkImportPath("//?/C:\\sessions/session.json", "win32")).toBe(false)
  expect(isNetworkImportPath("\\\\?\\C:/sessions\\session.json", "linux")).toBe(false)
  expect(isNetworkImportPath("\\\\server\\share\\session.json", "linux")).toBe(true)

  expect(() => requireLocalImportPath("https://example.test/share/abc")).toThrow("Remote URL and share imports")
  expect(() => requireLocalImportPath("ssh://example.test/session.json")).toThrow("Remote URL and share imports")
  expect(() => requireLocalImportPath("\\\\server\\share\\session.json")).toThrow("local filesystem")
  expect(() => requireLocalImportPath("\\\\?\\UNC\\server\\share\\session.json")).toThrow("local filesystem")
  expect(() => requireLocalImportPath("\\\\.\\UNC\\server\\share\\session.json")).toThrow("local filesystem")
  expect(requireLocalImportPath("./session.json")).toBe("./session.json")
  expect(requireLocalImportPath("//tmp/session.json")).toBe("//tmp/session.json")
  expect(requireLocalImportPath("C:\\sessions\\session.json")).toBe("C:\\sessions\\session.json")
  expect(requireLocalImportPath("C://sessions/session.json")).toBe("C://sessions/session.json")
  expect(requireLocalImportPath("\\\\?\\C:\\sessions\\session.json")).toBe("\\\\?\\C:\\sessions\\session.json")
})
