import { afterEach, expect, mock, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

void mock.module("electron", () => ({
  app: { isPackaged: true, getPath: () => "" },
  default: { app: { getPath: () => "" } },
}))
void mock.module("electron-log/main.js", () => ({
  default: { log: () => undefined, warn: () => undefined },
}))

const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

test("imports missing legacy store keys once without changing the legacy directory", async () => {
  const root = join(tmpdir(), `ruying-desktop-migrate-${crypto.randomUUID()}`)
  const legacy = join(root, "ai.opencode.desktop")
  const current = join(root, "cn.gwm.ruying-code")
  roots.push(root)
  mkdirSync(legacy, { recursive: true })
  mkdirSync(current, { recursive: true })
  writeFileSync(join(legacy, "default.dat"), JSON.stringify({ shared: "legacy", legacyOnly: "copied" }))
  writeFileSync(join(current, "default.dat"), JSON.stringify({ shared: "current", currentOnly: "kept" }))
  writeFileSync(join(legacy, "opencode.global.dat"), JSON.stringify({ language: "zh" }))

  const { migrateLegacyElectronData } = await import("./migrate")
  migrateLegacyElectronData(legacy, current)

  expect(await Bun.file(join(current, "default.dat")).json()).toEqual({
    shared: "current",
    legacyOnly: "copied",
    currentOnly: "kept",
  })
  expect(await Bun.file(join(current, "opencode.global.dat")).json()).toEqual({ language: "zh" })
  expect(await Bun.file(join(legacy, "default.dat")).json()).toEqual({ shared: "legacy", legacyOnly: "copied" })
  expect(await Bun.file(join(legacy, "opencode.global.dat")).exists()).toBe(true)

  writeFileSync(join(legacy, "opencode.global.dat"), JSON.stringify({ language: "en", addedLater: true }))
  migrateLegacyElectronData(legacy, current)

  expect(await Bun.file(join(current, "opencode.global.dat")).json()).toEqual({ language: "zh" })
})

test("does not mark a malformed legacy store as migrated", async () => {
  const root = join(tmpdir(), `ruying-desktop-migrate-${crypto.randomUUID()}`)
  const legacy = join(root, "ai.opencode.desktop")
  const current = join(root, "cn.gwm.ruying-code")
  roots.push(root)
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, "default.dat"), "not json")

  const { migrateLegacyElectronData } = await import("./migrate")
  expect(() => migrateLegacyElectronData(legacy, current)).toThrow()

  writeFileSync(join(legacy, "default.dat"), JSON.stringify({ recovered: true }))
  migrateLegacyElectronData(legacy, current)

  expect(await Bun.file(join(current, "default.dat")).json()).toEqual({ recovered: true })
})
