import { expect, test } from "bun:test"

test("OEM public surfaces contain no upstream docs, Discord, or GitHub exits", async () => {
  const sources = await Promise.all(
    [
      "desktop-menu.ts",
      "components/settings-v2/general.tsx",
      "components/settings-general.tsx",
      "components/help-button.tsx",
      "pages/error.tsx",
    ].map((file) => Bun.file(new URL(file, import.meta.url)).text()),
  )
  const publicSource = sources.join("\n")

  expect(publicSource).not.toContain("https://opencode.ai")
  expect(publicSource).not.toContain("https://discord.com/invite/opencode")
  expect(publicSource).not.toContain("https://github.com/anomalyco/opencode")
  expect(publicSource).not.toContain("Open the OpenCode website")
})
