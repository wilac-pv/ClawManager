import { afterEach, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"

const originalEnv = [
  "RUYING_CODE_CONFIG",
  "OPENCODE_CONFIG",
  "RUYING_CODE_FEATURE",
  "OPENCODE_FEATURE",
  "RUYING_CODE_SERVER_USERNAME",
  "OPENCODE_SERVER_USERNAME",
].map((key) => [key, process.env[key]] as const)

afterEach(() => {
  originalEnv.forEach((entry) => {
    if (entry[1] === undefined) {
      delete process.env[entry[0]]
      return
    }
    process.env[entry[0]] = entry[1]
  })
})

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
})

test("recognizes true and 1 environment values", () => {
  process.env.RUYING_CODE_FEATURE = "TRUE"
  expect(Brand.truthy("FEATURE")).toBe(true)
  process.env.RUYING_CODE_FEATURE = "1"
  expect(Brand.truthy("FEATURE")).toBe(true)
  process.env.RUYING_CODE_FEATURE = "false"
  expect(Brand.truthy("FEATURE")).toBe(false)
})

test("recognizes a legacy truthy environment value", () => {
  delete process.env.RUYING_CODE_FEATURE
  process.env.OPENCODE_FEATURE = "true"
  expect(Brand.truthy("FEATURE")).toBe(true)
})

test("prefers a false RUYING_CODE value over a truthy OPENCODE value", () => {
  process.env.RUYING_CODE_FEATURE = "false"
  process.env.OPENCODE_FEATURE = "true"
  expect(Brand.truthy("FEATURE")).toBe(false)
})

test("legacy flag properties prefer branded variables", async () => {
  process.env.RUYING_CODE_SERVER_USERNAME = "ruying"
  process.env.OPENCODE_SERVER_USERNAME = "legacy"
  const { Flag } = await import(`../src/flag/flag.ts?brand=${Date.now()}`)
  expect(Flag.OPENCODE_SERVER_USERNAME).toBe("ruying")
})
