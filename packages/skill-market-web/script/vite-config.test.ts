import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import config from "../vite.config"

test("production config rejects a missing Skill market API URL", () => {
  if (typeof config !== "function") throw new Error("Expected a Vite config function")

  const apiUrl = process.env.VITE_SKILL_MARKET_API_URL
  const allowInsecureHttp = process.env.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP
  delete process.env.VITE_SKILL_MARKET_API_URL
  delete process.env.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP

  try {
    expect(() => config({ command: "build", mode: "production", isSsrBuild: false, isPreview: false })).toThrow(
      "VITE_SKILL_MARKET_API_URL is required for production builds",
    )
  } finally {
    if (apiUrl === undefined) delete process.env.VITE_SKILL_MARKET_API_URL
    if (apiUrl !== undefined) process.env.VITE_SKILL_MARKET_API_URL = apiUrl
    if (allowInsecureHttp === undefined) delete process.env.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP
    if (allowInsecureHttp !== undefined) process.env.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP = allowInsecureHttp
  }
})

test(
  "production build accepts a configured Skill market API URL",
  async () => {
    const output = join(tmpdir(), `ruying-market-web-build-${crypto.randomUUID()}`)
    const subprocess = Bun.spawn([process.execPath, "run", "build", "--", "--outDir", output], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        VITE_SKILL_MARKET_API_URL: "http://10.0.0.1:4210",
        VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP: "true",
      },
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
