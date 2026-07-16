import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import config from "../vite.config"

test("production config allows a runtime same-origin API", () => {
  if (typeof config !== "function") throw new Error("Expected a Vite config function")
  expect(() => config({ command: "build", mode: "production", isSsrBuild: false, isPreview: false })).not.toThrow()
})

test(
  "production build accepts a configured Skill market API URL",
  async () => {
    const output = join(tmpdir(), `ruying-market-web-build-${crypto.randomUUID()}`)
    const environment = { ...process.env }
    delete environment.VITE_SKILL_MARKET_API_URL
    delete environment.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP
    const subprocess = Bun.spawn([process.execPath, "run", "build", "--", "--outDir", output], {
      cwd: join(import.meta.dir, ".."),
      env: environment,
      stdout: "ignore",
      stderr: "pipe",
    })
    const stderr = await new Response(subprocess.stderr).text()
    const exitCode = await subprocess.exited
    await rm(output, { recursive: true, force: true })

    expect({ exitCode, error: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, error: "" })
  },
  30_000,
)
