import { expect, test } from "bun:test"

test("provider integrations publish Ruying identity without upstream OpenCode origins", async () => {
  const source = await Bun.file(new URL("../../src/provider/provider.ts", import.meta.url)).text()

  expect(source).toContain("Brand.profile.englishName")
  expect(source).toContain("Brand.profile.cliName")
  expect(source).not.toContain("https://opencode.ai")
  expect(source).not.toContain('"X-Title": "opencode"')
  expect(source).not.toContain("`opencode/${InstallationVersion}")
})
