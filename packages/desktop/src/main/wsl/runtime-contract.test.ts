import { expect, test } from "bun:test"

test("production WSL installation, resolution, and launch use only Ruying Code from Nexus", async () => {
  const runtime = await Bun.file(new URL("./runtime.ts", import.meta.url)).text()
  const sidecar = await Bun.file(new URL("./sidecar.ts", import.meta.url)).text()

  expect(runtime).toContain("https://nexus.gwm.cn/repository/npm-group/")
  expect(runtime).toContain("@ruying/ruying-code")
  expect(runtime).toContain("ruying-code")
  expect(runtime).toContain("command -v npm")
  expect(runtime).not.toContain("command -v curl")
  expect(runtime).not.toContain("https://opencode.ai/install")
  expect(runtime).not.toContain("$HOME/.opencode/bin/opencode")

  expect(sidecar).toContain("resolveWslRuyingCode")
  expect(sidecar).toContain("Ruying Code")
  expect(sidecar).not.toContain("resolveWslOpencode")
  expect(sidecar).not.toContain("OpenCode is not installed")
})
