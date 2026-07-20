import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatChecks, runPreflight, runPrivateCanary, runSmoke } from "./deploy-check"

const directories: string[] = []
const servers: Bun.Server<undefined>[] = []

afterEach(async () => {
  servers.splice(0).forEach((server) => server.stop(true))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("deployment checks", () => {
  test("reports configuration names without exposing environment secrets", async () => {
    const directory = await temporaryDirectory()
    const databaseDirectory = join(directory, "data")
    const environmentFile = join(directory, "market.env")
    await mkdir(databaseDirectory)
    await Bun.write(environmentFile, "AWS_SECRET_ACCESS_KEY=secret-marker\nSSO_TOKEN=token-marker\n")
    await chmod(environmentFile, 0o644)
    const environment = validEnvironment(databaseDirectory)
    environment.AWS_ACCESS_KEY_ID = "access-marker"
    environment.AWS_SECRET_ACCESS_KEY = "secret-marker"

    const checks = await runPreflight({
      environment,
      environmentFile,
      findBinary: () => "/usr/bin/tool",
      probe: async () => true,
    })
    const output = formatChecks(checks)

    expect(checks.find((check) => check.name === "environment-file")?.status).toBe("FAIL")
    expect(output).not.toContain("access-marker")
    expect(output).not.toContain("secret-marker")
    expect(output).not.toContain("token-marker")
  })

  test("rejects overlapping prefixes and insecure public configuration", async () => {
    const directory = await temporaryDirectory()
    const environmentFile = join(directory, "market.env")
    await Bun.write(environmentFile, "# test\n")
    await chmod(environmentFile, 0o600)
    const environment = validEnvironment(directory)
    environment.SKILL_MARKET_PRIVATE_OSS_PREFIX = `${environment.SKILL_MARKET_OSS_PREFIX}/private`
    environment.SKILL_MARKET_PUBLIC_BASE_URL = "http://10.0.0.8/public/"

    const checks = await runPreflight({ environment, environmentFile, findBinary: () => undefined })

    expect(checks.find((check) => check.name === "configuration")?.status).toBe("FAIL")
    expect(formatChecks(checks)).toContain("FAIL configuration")
  })

  test("CLI reports an invalid mirror number without leaking configuration or throwing", async () => {
    const directory = await temporaryDirectory()
    const databaseDirectory = join(directory, "data")
    const backupDirectory = join(directory, "backups")
    const environmentFile = join(directory, "market.env")
    await Promise.all([mkdir(databaseDirectory), mkdir(backupDirectory), Bun.write(environmentFile, "# test\n")])
    await chmod(environmentFile, 0o600)
    const subprocess = Bun.spawn([process.execPath, "script/deploy-check.ts", "preflight"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...validEnvironment(databaseDirectory),
        SKILL_MARKET_MIGRATION_BACKUP_DIRECTORY: backupDirectory,
        SKILL_MARKET_ENV_FILE: environmentFile,
        SKILL_MARKET_SKILLHUB_PAGE_CONCURRENCY: "17",
        SKILL_MARKET_SKILLHUB_MEMORY_SOFT_LIMIT_MB: "511",
        AWS_SECRET_ACCESS_KEY: "secret-marker",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ])

    expect(exitCode).toBe(1)
    expect(stdout).toContain("FAIL configuration")
    expect(stdout).not.toContain("17")
    expect(stdout).not.toContain("511")
    expect(stdout).not.toContain("secret-marker")
    expect(stderr).toBe("")
  })

  test("reports non-secret SkillHub numeric configuration and requires writable backup storage", async () => {
    const directory = await temporaryDirectory()
    const databaseDirectory = join(directory, "data")
    const backupDirectory = join(directory, "backups")
    const environmentFile = join(directory, "market.env")
    await Promise.all([mkdir(databaseDirectory), mkdir(backupDirectory), Bun.write(environmentFile, "# test\n")])
    await chmod(environmentFile, 0o600)
    const environment = validEnvironment(databaseDirectory)
    environment.SKILL_MARKET_MIGRATION_BACKUP_DIRECTORY = backupDirectory
    environment.SKILL_MARKET_SKILLHUB_PAGE_CONCURRENCY = "4"
    environment.SKILL_MARKET_SKILLHUB_METADATA_CONCURRENCY = "8"
    environment.SKILL_MARKET_SKILLHUB_PACKAGE_CONCURRENCY = "6"
    environment.SKILL_MARKET_SKILLHUB_PUBLISH_BATCH = "2000"
    environment.SKILL_MARKET_SKILLHUB_PUBLISH_MINUTES = "30"
    environment.SKILL_MARKET_SKILLHUB_MEMORY_SOFT_LIMIT_MB = "1536"

    const checks = await runPreflight({ environment, environmentFile, findBinary: () => "/usr/bin/tool", probe: async () => true })
    const output = formatChecks(checks)

    expect(checks.find((check) => check.name === "backup-directory")?.status).toBe("PASS")
    expect(output).toContain("PASS skillhub-page-concurrency=4")
    expect(output).toContain("PASS skillhub-memory-soft-limit-mb=1536")
    expect(output).not.toContain("AWS_SECRET_ACCESS_KEY")

    await rm(backupDirectory, { force: true, recursive: true })
    const missingBackupChecks = await runPreflight({
      environment,
      environmentFile,
      findBinary: () => "/usr/bin/tool",
      probe: async () => true,
    })
    expect(missingBackupChecks.find((check) => check.name === "backup-directory")?.status).toBe("FAIL")
  })

  test("checks health, catalog CORS, anonymous session, and off-origin writes", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/health") return Response.json({ status: "ok", ready: true })
        if (url.pathname === "/v1/catalog/skills")
          return new Response(request.method === "HEAD" || request.method === "OPTIONS" ? null : "{}", {
            status: request.method === "OPTIONS" ? 204 : 200,
            headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
          })
        if (url.pathname === "/v1/auth/session")
          return new Response("null", {
            headers: {
              "access-control-allow-origin": "http://127.0.0.1:4211",
              "access-control-allow-credentials": "true",
              "cache-control": "no-store",
              "content-type": "application/json",
            },
          })
        return Response.json({ code: "forbidden" }, { status: 403, headers: { "cache-control": "no-store" } })
      },
    })
    servers.push(server)

    const checks = await runSmoke({
      apiUrl: `http://127.0.0.1:${server.port}`,
      webOrigin: "http://127.0.0.1:4211",
    })

    expect(checks.every((check) => check.status === "PASS")).toBe(true)
  })

  test("writes and removes a canary only under the configured private prefix", async () => {
    const objects = new Map<string, Uint8Array>()
    const store = {
      async putPrivate(key: string, body: AsyncIterable<Uint8Array>) {
        objects.set(key, Buffer.concat(await Array.fromAsync(body)))
      },
      async get(key: string) {
        const value = objects.get(key)
        if (!value) throw new Error("missing")
        return value
      },
      async head(key: string) {
        const value = objects.get(key)
        if (!value) throw Object.assign(new Error("missing"), { name: "NotFound" })
        return { size: value.byteLength }
      },
      async delete(key: string) {
        objects.delete(key)
      },
    }

    const result = await runPrivateCanary({ privatePrefix: "private-test", store, allow: true })
    expect(result.status).toBe("PASS")
    expect(objects.size).toBe(0)
    await expect(runPrivateCanary({ privatePrefix: "../public", store, allow: true })).rejects.toThrow(
      "private canary prefix is invalid",
    )
    await expect(runPrivateCanary({ privatePrefix: "private-test", store, allow: false })).rejects.toThrow(
      "private canary requires explicit permission",
    )
  })

  test("accepts only explicit missing-object errors after private canary cleanup", async () => {
    for (const missing of [
      { $metadata: { httpStatusCode: 404 } },
      { name: "NotFound" },
      { name: "NoSuchKey" },
    ])
      await expect(runPrivateCanary({ privatePrefix: "private-test", store: privateCanaryStore(missing), allow: true })).resolves.toEqual({
        name: "private-canary",
        status: "PASS",
      })

    for (const failure of [
      { $metadata: { httpStatusCode: 503 }, message: "secret-marker" },
      { name: "AccessDenied", message: "secret-marker" },
      new Error("secret-marker timeout"),
    ]) {
      const error = await runPrivateCanary({ privatePrefix: "private-test", store: privateCanaryStore(failure), allow: true }).catch(
        (error) => error,
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("private canary cleanup failed")
      expect((error as Error).message).not.toContain("secret-marker")
    }
  })
})

function privateCanaryStore(afterDelete: unknown) {
  const objects = new Map<string, Uint8Array>()
  return {
    async putPrivate(key: string, body: AsyncIterable<Uint8Array>) {
      objects.set(key, Buffer.concat(await Array.fromAsync(body)))
    },
    async get(key: string) {
      const value = objects.get(key)
      if (!value) throw new Error("missing")
      return value
    },
    async head(key: string) {
      const value = objects.get(key)
      if (!value) throw afterDelete
      return { size: value.byteLength }
    },
    async delete(key: string) {
      objects.delete(key)
    },
  }
}

function validEnvironment(databaseDirectory: string) {
  return {
    SKILL_MARKET_DATABASE_PATH: join(databaseDirectory, "market.db"),
    SKILL_MARKET_MIGRATION_BACKUP_DIRECTORY: join(databaseDirectory, "migrations"),
    SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://enterprise.example.com/index.json",
    SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
    SKILL_MARKET_OSS_BUCKET: "market-test",
    SKILL_MARKET_OSS_PREFIX: "public-test",
    SKILL_MARKET_PRIVATE_OSS_PREFIX: "private-test",
    SKILL_MARKET_PUBLIC_BASE_URL: "https://cdn.example.com/public-test/",
    SKILL_MARKET_WEB_ORIGIN: "https://market.example.com",
    SKILL_MARKET_API_PUBLIC_URL: "https://market.example.com",
    SKILL_MARKET_SSO_LOGIN_URL: "https://sso.example.com/login",
    SKILL_MARKET_ADMIN_API_BASE_URL: "https://admin.example.com",
  } satisfies Record<string, string>
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-deploy-check-"))
  directories.push(directory)
  return directory
}
