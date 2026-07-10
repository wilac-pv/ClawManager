import { expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"

test("defines the public ruying identity", () => {
  expect(Brand.profile).toEqual({
    displayName: "如影 Code",
    englishName: "Ruying Code",
    cliName: "ruying-code",
    legacyCliName: "opencode",
    packageName: "@ruying/ruying-code",
    storageName: "ruying-code",
    legacyStorageName: "opencode",
    projectDirectory: ".ruying-code",
    legacyProjectDirectory: ".opencode",
    providerID: "ruying",
  })
})

test("prefers RUYING_CODE variables over OPENCODE variables", () => {
  process.env.RUYING_CODE_CONFIG = "new.json"
  process.env.OPENCODE_CONFIG = "old.json"
  expect(Brand.env("CONFIG")).toBe("new.json")
  delete process.env.RUYING_CODE_CONFIG
  expect(Brand.env("CONFIG")).toBe("old.json")
  delete process.env.OPENCODE_CONFIG
})

test("recognizes true and 1 environment values", () => {
  process.env.RUYING_CODE_FEATURE = "TRUE"
  expect(Brand.truthy("FEATURE")).toBe(true)
  process.env.RUYING_CODE_FEATURE = "1"
  expect(Brand.truthy("FEATURE")).toBe(true)
  process.env.RUYING_CODE_FEATURE = "false"
  expect(Brand.truthy("FEATURE")).toBe(false)
  delete process.env.RUYING_CODE_FEATURE
})
