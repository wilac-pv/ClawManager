import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { rejectMountedWslExecutable, wslPathSetupScript } from "./runtime"

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
  expect(runtime).toContain("sanitizeWslPath")
  expect(runtime).toContain('linux_path=$(sanitizeWslPath "$PATH")')
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

test("WSL PATH sanitization preserves Linux tool managers and filters Windows mounts", () => {
  const result = spawnSync("/bin/sh", ["-c", `${wslPathSetupScript()}; printf "%s" "$PATH"`], {
    encoding: "utf8",
    env: {
      HOME: "/home/tester",
      PATH: "/mnt/c/Program Files/node:/home/tester/.nvm/versions/node/v22/bin:/opt/volta/bin:/snap/bin:/mnt/d/bin",
    },
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toBe(
    "/home/tester/.local/bin:/home/tester/.nvm/versions/node/v22/bin:/opt/volta/bin:/snap/bin",
  )
  expect(rejectMountedWslExecutable("/mnt/c/Program Files/node/npm")).toBeNull()
  expect(rejectMountedWslExecutable("/home/tester/.nvm/versions/node/v22/bin/npm")).toBe(
    "/home/tester/.nvm/versions/node/v22/bin/npm",
  )
})
