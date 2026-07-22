import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRelease } from "./build-release"

const directories: string[] = []
const processes: Bun.Subprocess[] = []

afterEach(async () => {
  processes.splice(0).forEach((process) => process.kill())
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await setPermissions(directory, 0o700, 0o600)
      await rm(directory, { force: true, recursive: true })
    }),
  )
})

describe("runtime release build", () => {
  test("starts from an immutable release without installing unresolved packages", async () => {
    const directory = await temporaryDirectory()
    const outputDirectory = join(directory, "release")
    const dataDirectory = join(directory, "data")
    const homeDirectory = join(directory, "home")
    await Promise.all([mkdir(dataDirectory), mkdir(homeDirectory)])
    await buildRelease(outputDirectory)

    const serverDirectory = join(outputDirectory, "packages/skill-market-server")
    expect(await Bun.file(join(serverDirectory, "node_modules/esprima/package.json")).json()).toMatchObject({
      name: "esprima",
      version: "4.0.1",
    })
    const worker = await Bun.file(join(serverDirectory, "src/worker.ts")).text()
    expect(worker).toContain("webBaseUrl: config.webBaseUrl")
    expect(worker).not.toContain("webBaseUrl: config.webOrigin")
    const skillhubWorker = Bun.file(join(serverDirectory, "src/skillhub-worker.js"))
    expect(await skillhubWorker.exists()).toBe(true)
    expect(await skillhubWorker.text()).toContain("runConfiguredSkillHubWorker")
    const evaluationWorker = Bun.file(join(serverDirectory, "src/skillhub-evaluation-worker.js"))
    expect(await evaluationWorker.exists()).toBe(true)
    expect(await evaluationWorker.text()).toContain("runConfiguredSkillHubEvaluationWorker")
    expect(await evaluationWorker.text()).toContain("publishCompletedSkillHubEvaluations")
    const evaluationService = Bun.file(
      join(serverDirectory, "deploy/systemd/ruying-skill-market-evaluation.service"),
    )
    expect(await evaluationService.exists()).toBe(true)
    expect(await evaluationService.text()).toContain("MemoryHigh=896M")
    expect(await evaluationService.text()).toContain("MemoryMax=1024M")
    expect(await evaluationService.text()).toContain("TimeoutStartSec=65s")
    expect(await evaluationService.text()).toContain("TimeoutStopSec=10s")
    await setPermissions(outputDirectory, 0o555, 0o444)
    await chmod(homeDirectory, 0o555)

    const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = reservation.port
    reservation.stop(true)
    const subprocess = Bun.spawn([process.execPath, "src/server.ts"], {
      cwd: serverDirectory,
      env: {
        HOME: homeDirectory,
        PATH: process.env.PATH,
        SKILL_MARKET_PORT: String(port),
        SKILL_MARKET_DATABASE_PATH: join(dataDirectory, "market.db"),
        SKILL_MARKET_MIGRATION_BACKUP_DIRECTORY: join(dataDirectory, "migrations"),
        SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://enterprise.example.com/index.json",
        SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
        SKILL_MARKET_OSS_BUCKET: "market-test",
        SKILL_MARKET_OSS_PREFIX: "public-test",
        SKILL_MARKET_PRIVATE_OSS_PREFIX: "private-test",
        SKILL_MARKET_PUBLIC_BASE_URL: "https://cdn.example.com/public-test/",
        SKILL_MARKET_WEB_ORIGIN: "http://127.0.0.1:4211",
        SKILL_MARKET_API_PUBLIC_URL: `http://127.0.0.1:${port}`,
        SKILL_MARKET_SSO_LOGIN_URL: "https://sso.example.com/login",
        SKILL_MARKET_ADMIN_API_BASE_URL: "https://admin.example.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    processes.push(subprocess)

    const response = await health(`http://127.0.0.1:${port}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok", ready: true })
    subprocess.kill()
    const stderr = await new Response(subprocess.stderr).text()
    expect(stderr).not.toContain("Resolving")
    expect(stderr).not.toContain("unable to write files")
  }, 30_000)
})

async function health(url: string) {
  return Promise.any(
    Array.from({ length: 100 }, (_, index) =>
      Bun.sleep(index * 25).then(() => fetch(url).catch(() => Promise.reject(new Error("not ready")))),
    ),
  )
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-release-"))
  directories.push(directory)
  return directory
}

async function setPermissions(directory: string, directoryMode: number, fileMode: number) {
  await chmod(directory, directoryMode)
  await Promise.all(
    (await readdir(directory, { withFileTypes: true })).map((entry) =>
      entry.isDirectory()
        ? setPermissions(join(directory, entry.name), directoryMode, fileMode)
        : chmod(join(directory, entry.name), fileMode),
    ),
  )
}
