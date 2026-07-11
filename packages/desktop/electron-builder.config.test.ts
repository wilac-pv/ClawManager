import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"

const channels = [
  { channel: "dev", appId: "cn.gwm.ruying-code.dev", name: "如影 Code Dev", rpm: "ruying-code-dev" },
  { channel: "beta", appId: "cn.gwm.ruying-code.beta", name: "如影 Code Beta", rpm: "ruying-code-beta" },
  { channel: "prod", appId: "cn.gwm.ruying-code", name: "如影 Code", rpm: "ruying-code" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    const previousUpdateUrl = process.env.RUYING_CODE_DESKTOP_UPDATE_URL
    process.env.OPENCODE_CHANNEL = channel.channel
    delete process.env.RUYING_CODE_DESKTOP_UPDATE_URL

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous
    if (previousUpdateUrl === undefined) delete process.env.RUYING_CODE_DESKTOP_UPDATE_URL
    else process.env.RUYING_CODE_DESKTOP_UPDATE_URL = previousUpdateUrl

    expect(config.appId).toBe(channel.appId)
    expect(config.productName).toBe(channel.name)
    expect(config.artifactName).toBe("ruying-code-desktop-${os}-${arch}.${ext}")
    expect(config.protocols).toEqual({ name: channel.name, schemes: ["ruying-code", "opencode"] })
    expect(config.publish).toBeUndefined()
    expect(config.rpm?.packageName).toBe(channel.rpm)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
  })
}

test("uses the internal update feed when configured", async () => {
  const previous = process.env.RUYING_CODE_DESKTOP_UPDATE_URL
  process.env.RUYING_CODE_DESKTOP_UPDATE_URL = "https://updates.gwm.example/ruying-code/"

  const module = await import("./electron-builder.config.ts?update=generic")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.RUYING_CODE_DESKTOP_UPDATE_URL
  else process.env.RUYING_CODE_DESKTOP_UPDATE_URL = previous

  expect(config.publish).toEqual({
    provider: "generic",
    url: "https://updates.gwm.example/ruying-code/",
  })
})

test("injects whether the internal update feed is configured into the main bundle", async () => {
  const previous = process.env.RUYING_CODE_DESKTOP_UPDATE_URL
  delete process.env.RUYING_CODE_DESKTOP_UPDATE_URL

  const absent = await import("./electron.vite.config.ts?update=absent")

  process.env.RUYING_CODE_DESKTOP_UPDATE_URL = "https://updates.gwm.example/ruying-code/"
  const configured = await import("./electron.vite.config.ts?update=configured")

  if (previous === undefined) delete process.env.RUYING_CODE_DESKTOP_UPDATE_URL
  else process.env.RUYING_CODE_DESKTOP_UPDATE_URL = previous

  expect(absent.default.main?.define?.["import.meta.env.RUYING_CODE_DESKTOP_UPDATE_URL"]).toBe('""')
  expect(configured.default.main?.define?.["import.meta.env.RUYING_CODE_DESKTOP_UPDATE_URL"]).toBe(
    '"https://updates.gwm.example/ruying-code/"',
  )
})

test("generates branded Linux package metadata without OpenCode release links", async () => {
  const branded = join(import.meta.dir, "resources", "cn.gwm.ruying-code.metainfo.xml")
  const legacy = join(import.meta.dir, "resources", "ai.opencode.desktop.metainfo.xml")
  rmSync(branded, { force: true })
  rmSync(legacy, { force: true })

  const process = Bun.spawn(["bun", "scripts/copy-metainfo.ts", "prod"], { cwd: import.meta.dir })
  const exitCode = await process.exited
  const exists = await Bun.file(branded).exists()
  const metadata = exists ? await Bun.file(branded).text() : ""
  rmSync(branded, { force: true })
  rmSync(legacy, { force: true })

  expect(exitCode).toBe(0)
  expect(metadata).toContain("<id>cn.gwm.ruying-code</id>")
  expect(metadata).toContain("<name>如影 Code</name>")
  expect(metadata).not.toContain("github.com/anomalyco/opencode")
  expect(metadata).not.toContain("opencode.ai")
})

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.deb?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`)
  expect(config.rpm?.fpm?.[0]).toEndWith(`${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Name=如影 Code")
  expect(desktop).toContain('Exec="/opt/如影 Code/cn.gwm.ruying-code" %U')
  expect(desktop).toContain("Icon=cn.gwm.ruying-code")
  expect(desktop).toContain("StartupWMClass=cn.gwm.ruying-code")
  expect(desktop).toContain("NoDisplay=true")
})

test("brands Windows menu accessibility text and the native startup title", async () => {
  const appMenu = await Bun.file(join(import.meta.dir, "../app/src/components/windows-app-menu.tsx")).text()
  const windows = await Bun.file(join(import.meta.dir, "src/main/windows.ts")).text()

  expect(appMenu).toContain('aria-label="如影 Code menu"')
  expect(appMenu).toContain(">如影 Code</DropdownMenu.GroupLabel>")
  expect(appMenu).not.toContain('aria-label="OpenCode menu"')
  expect(windows).toContain('title: "如影 Code"')
  expect(windows).not.toContain('title: "OpenCode"')
})
