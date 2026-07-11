import { afterEach, expect, mock, test } from "bun:test"
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
const markerName = ".legacy-electron-migrated"

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

test("resolves the old Bundle-ID data root for sidecar migration", async () => {
  const { legacyElectronDataPath } = await import("./migrate")
  expect(legacyElectronDataPath("/app-data", "prod")).toBe(join("/app-data", "ai.opencode.desktop"))
  expect(legacyElectronDataPath("C:\\AppData", "beta")).toBe(join("C:\\AppData", "ai.opencode.desktop.beta"))
})

test("imports prototype-named own keys while preserving current own keys", async () => {
  const root = join(tmpdir(), `ruying-desktop-migrate-${crypto.randomUUID()}`)
  const legacy = join(root, "ai.opencode.desktop")
  const current = join(root, "cn.gwm.ruying-code")
  roots.push(root)
  mkdirSync(legacy, { recursive: true })
  mkdirSync(current, { recursive: true })
  writeFileSync(
    join(legacy, "default.dat"),
    '{"toString":"legacy","constructor":"legacy","__proto__":"legacy","hasOwnProperty":"legacy"}',
  )
  writeFileSync(join(current, "default.dat"), "{}")
  writeFileSync(join(legacy, "opencode.global.dat"), '{"constructor":"legacy","normal":"legacy"}')
  writeFileSync(join(current, "opencode.global.dat"), '{"constructor":"current"}')

  const { migrateLegacyElectronData } = await import("./migrate")
  migrateLegacyElectronData(legacy, current)

  const migrated = await Bun.file(join(current, "default.dat")).json()
  expect(migrated).toEqual(
    JSON.parse('{"toString":"legacy","constructor":"legacy","__proto__":"legacy","hasOwnProperty":"legacy"}'),
  )
  expect(Object.hasOwn(migrated, "__proto__")).toBe(true)
  expect(await Bun.file(join(current, "opencode.global.dat")).json()).toEqual({
    constructor: "current",
    normal: "legacy",
  })
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
  expect(readdirSync(current).filter((entry) => entry.includes(`${markerName}.`) && entry.endsWith(".tmp"))).toEqual([])
})

test("replaces malformed marker files instead of skipping migration", async () => {
  const root = join(tmpdir(), `ruying-desktop-migrate-${crypto.randomUUID()}`)
  const legacy = join(root, "ai.opencode.desktop")
  const current = join(root, "cn.gwm.ruying-code")
  roots.push(root)
  mkdirSync(legacy, { recursive: true })
  mkdirSync(current, { recursive: true })
  writeFileSync(join(legacy, "default.dat"), JSON.stringify({ migrated: true }))
  writeFileSync(join(current, markerName), "not json")

  const { migrateLegacyElectronData } = await import("./migrate")
  migrateLegacyElectronData(legacy, current)

  expect(await Bun.file(join(current, "default.dat")).json()).toEqual({ migrated: true })
  expect(JSON.parse(readFileSync(join(current, markerName), "utf8"))).toMatchObject({ version: 1 })
})

test("does not accept a marker from a different migration version", async () => {
  const root = join(tmpdir(), `ruying-desktop-migrate-${crypto.randomUUID()}`)
  const legacy = join(root, "ai.opencode.desktop")
  const current = join(root, "cn.gwm.ruying-code")
  roots.push(root)
  mkdirSync(legacy, { recursive: true })
  mkdirSync(current, { recursive: true })
  writeFileSync(join(legacy, "default.dat"), JSON.stringify({ migrated: true }))
  writeFileSync(join(current, markerName), JSON.stringify({ version: 0, migratedAt: new Date().toISOString() }))

  const { migrateLegacyElectronData } = await import("./migrate")
  migrateLegacyElectronData(legacy, current)

  expect(await Bun.file(join(current, "default.dat")).json()).toEqual({ migrated: true })
  expect(JSON.parse(readFileSync(join(current, markerName), "utf8"))).toMatchObject({ version: 1 })
})

test("unlinks marker symlinks without following their target", async () => {
  const root = join(tmpdir(), `ruying-desktop-migrate-${crypto.randomUUID()}`)
  const legacy = join(root, "ai.opencode.desktop")
  const current = join(root, "cn.gwm.ruying-code")
  const target = join(root, "target.json")
  roots.push(root)
  mkdirSync(legacy, { recursive: true })
  mkdirSync(current, { recursive: true })
  writeFileSync(join(legacy, "default.dat"), JSON.stringify({ migrated: true }))
  writeFileSync(target, "preserve me")
  symlinkSync(target, join(current, markerName))

  const { migrateLegacyElectronData } = await import("./migrate")
  migrateLegacyElectronData(legacy, current)

  expect(readFileSync(target, "utf8")).toBe("preserve me")
  expect(lstatSync(join(current, markerName)).isFile()).toBe(true)
  expect(lstatSync(join(current, markerName)).isSymbolicLink()).toBe(false)
  expect(await Bun.file(join(current, "default.dat")).json()).toEqual({ migrated: true })
})

test("replaces an empty marker directory but preserves and rejects a non-empty one", async () => {
  const root = join(tmpdir(), `ruying-desktop-migrate-${crypto.randomUUID()}`)
  const legacy = join(root, "ai.opencode.desktop")
  const emptyCurrent = join(root, "empty", "cn.gwm.ruying-code")
  const nonEmptyCurrent = join(root, "non-empty", "cn.gwm.ruying-code")
  roots.push(root)
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, "default.dat"), JSON.stringify({ migrated: true }))
  mkdirSync(join(emptyCurrent, markerName), { recursive: true })
  mkdirSync(join(nonEmptyCurrent, markerName), { recursive: true })
  writeFileSync(join(nonEmptyCurrent, markerName, "keep.txt"), "keep")

  const { migrateLegacyElectronData } = await import("./migrate")
  migrateLegacyElectronData(legacy, emptyCurrent)
  expect(lstatSync(join(emptyCurrent, markerName)).isFile()).toBe(true)

  expect(() => migrateLegacyElectronData(legacy, nonEmptyCurrent)).toThrow()
  expect(readFileSync(join(nonEmptyCurrent, markerName, "keep.txt"), "utf8")).toBe("keep")
  expect(await Bun.file(join(nonEmptyCurrent, "default.dat")).exists()).toBe(false)
})
