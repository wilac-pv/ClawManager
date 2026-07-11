import { afterEach, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigProvider, Effect } from "effect"

const originalEnv = [
  "RUYING_CODE_CONFIG",
  "OPENCODE_CONFIG",
  "RUYING_CODE_FEATURE",
  "OPENCODE_FEATURE",
  "RUYING_CODE_SERVER_USERNAME",
  "OPENCODE_SERVER_USERNAME",
  "RUYING_CODE_EXPERIMENTAL_FILEWATCHER",
  "OPENCODE_EXPERIMENTAL_FILEWATCHER",
  "RUYING_CODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
  "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
  "RUYING_CODE_DOCS_URL",
  "OPENCODE_DOCS_URL",
  "RUYING_CODE_SUPPORT_URL",
  "OPENCODE_SUPPORT_URL",
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

test("keeps docs and support URLs optional with branded-first aliases", () => {
  process.env.OPENCODE_DOCS_URL = "https://legacy.example/docs"
  process.env.RUYING_CODE_DOCS_URL = "https://internal.example/docs"
  process.env.OPENCODE_SUPPORT_URL = "https://legacy.example/support"
  expect(Brand.docsURL()).toBe("https://internal.example/docs")
  expect(Brand.supportURL()).toBe("https://legacy.example/support")
  delete process.env.RUYING_CODE_DOCS_URL
  delete process.env.OPENCODE_DOCS_URL
  delete process.env.OPENCODE_SUPPORT_URL
  expect(Brand.docsURL()).toBeUndefined()
  expect(Brand.supportURL()).toBeUndefined()
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

test("file watcher config prefers a branded false value", async () => {
  process.env.RUYING_CODE_EXPERIMENTAL_FILEWATCHER = "false"
  process.env.OPENCODE_EXPERIMENTAL_FILEWATCHER = "true"
  expect(
    await Effect.runPromise(Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER.parse(ConfigProvider.fromEnv())),
  ).toBe(false)
})

test("disable file watcher config accepts a legacy-only value", async () => {
  delete process.env.RUYING_CODE_EXPERIMENTAL_DISABLE_FILEWATCHER
  process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
  expect(
    await Effect.runPromise(Flag.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER.parse(ConfigProvider.fromEnv())),
  ).toBe(true)
})

test("file watcher config rejects an invalid branded value", async () => {
  process.env.RUYING_CODE_EXPERIMENTAL_FILEWATCHER = "invalid"
  process.env.OPENCODE_EXPERIMENTAL_FILEWATCHER = "true"
  await expect(
    Effect.runPromise(Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER.parse(ConfigProvider.fromEnv())),
  ).rejects.toThrow()
})
