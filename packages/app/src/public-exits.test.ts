import { expect, test } from "bun:test"

test("OEM public surfaces contain no upstream docs, Discord, or GitHub exits", async () => {
  const sources = await Promise.all(
    [
      "desktop-menu.ts",
      "components/settings-v2/general.tsx",
      "components/settings-general.tsx",
      "components/help-button.tsx",
      "pages/error.tsx",
      "pages/layout/helpers.ts",
    ].map((file) => Bun.file(new URL(file, import.meta.url)).text()),
  )
  const publicSource = sources.join("\n")

  expect(publicSource).not.toContain("https://opencode.ai")
  expect(publicSource).not.toContain("https://discord.com/invite/opencode")
  expect(publicSource).not.toContain("https://github.com/anomalyco/opencode")
  expect(publicSource).not.toContain("Open the OpenCode website")
})

test("all WSL locale values use Ruying Code branding, including multiline values", async () => {
  const files = Array.fromAsync(new Bun.Glob("i18n/*.ts").scan({ cwd: import.meta.dir, absolute: true }))
  const sources = await Promise.all((await files).map((file) => Bun.file(file).text()))
  const wsl = sources.flatMap((source) => {
    const lines = source.split("\n")
    return lines.flatMap((line, index) =>
      line.includes('"wsl.') || line.includes('"settings.desktop.wsl') ? [line, lines[index + 1] ?? ""] : [],
    )
  })
  expect(wsl.join("\n")).not.toContain("OpenCode")
})

test("all visible updater and settings locale values use Ruying Code branding", async () => {
  const files = Array.fromAsync(new Bun.Glob("i18n/*.ts").scan({ cwd: import.meta.dir, absolute: true }))
  const sources = await Promise.all((await files).map((file) => Bun.file(file).text()))
  const visible = sources.flatMap((source) => {
    const lines = source.split("\n")
    return lines.flatMap((line, index) =>
      line.includes('"toast.update.') || line.includes('"settings.') ? [line, lines[index + 1] ?? ""] : [],
    )
  })
  expect(visible.join("\n")).not.toContain("OpenCode")
})

test("all locale values avoid visible upstream product and config names", async () => {
  const files = Array.fromAsync(new Bun.Glob("i18n/*.ts").scan({ cwd: import.meta.dir, absolute: true }))
  const sources = await Promise.all((await files).map((file) => Bun.file(file).text()))
  expect(sources.join("\n")).not.toContain("OpenCode")
  expect(sources.join("\n")).not.toContain("opencode.json")
})

test("OEM resource paths contain no upstream fetching or notification icons", async () => {
  const sources = await Promise.all(
    ["context/highlights.tsx", "entry.tsx", "../../desktop/src/renderer/index.tsx"].map((file) =>
      Bun.file(new URL(file, import.meta.url)).text(),
    ),
  )

  expect(sources.join("\n")).not.toContain("https://opencode.ai")
})
