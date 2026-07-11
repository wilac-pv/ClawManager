import { expect, test } from "bun:test"

test("production WSL installation, resolution, and launch use only Ruying Code from Nexus", async () => {
  const runtime = await Bun.file(new URL("./runtime.ts", import.meta.url)).text()
  const sidecar = await Bun.file(new URL("./sidecar.ts", import.meta.url)).text()
  const servers = await Bun.file(new URL("./servers.ts", import.meta.url)).text()

  expect(runtime).toContain("https://nexus.gwm.cn/repository/npm-group/")
  expect(runtime).toContain("@ruying/ruying-code")
  expect(runtime).toContain("ruying-code")
  expect(runtime).toContain("command -v npm")
  expect(runtime).toContain('--prefix "$HOME/.local"')
  expect(runtime).toContain('case "$resolved" in /mnt/*)')
  expect(runtime).toContain('const WSL_LINUX_PATH = "$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"')
  expect(runtime).toContain('npm_path=$(PATH="${WSL_LINUX_PATH}" command -v npm')
  expect(runtime).toContain('case "$npm_path" in /mnt/*|"")')
  expect(runtime).not.toContain("command -v curl")
  expect(runtime).not.toContain("https://opencode.ai/install")
  expect(runtime).not.toContain("$HOME/.opencode/bin/opencode")

  expect(sidecar).toContain("resolveWslRuyingCode")
  expect(sidecar).toContain("Ruying Code")
  expect(sidecar).not.toContain("resolveWslOpencode")
  expect(sidecar).not.toContain("OpenCode is not installed")
  expect(servers).not.toContain("OpenCode installation failed")
})
