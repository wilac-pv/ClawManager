import { loadConfig } from "../src/config"
import { isExplicitMissingObjectError } from "../src/oss"
import { access, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname } from "node:path"

type Environment = Record<string, string | undefined>

export interface DeploymentCheck {
  readonly name: string
  readonly status: "PASS" | "FAIL" | "SKIP"
}

export async function runPreflight(options: {
  readonly environment: Environment
  readonly environmentFile: string
  readonly findBinary?: (name: string) => string | undefined
  readonly probe?: (url: string) => Promise<boolean>
}) {
  const configuration = configured(options.environment)
  const findBinary = options.findBinary ?? Bun.which
  const probe = options.probe ?? probeUrl
  const checks: DeploymentCheck[] = [
    { name: "configuration", status: configuration ? "PASS" : "FAIL" },
    await fileCheck(options.environmentFile),
    await databaseDirectoryCheck(options.environment.SKILL_MARKET_DATABASE_PATH),
    await directoryCheck(options.environment.SKILL_MARKET_MIGRATION_BACKUP_DIRECTORY, "backup-directory"),
    { name: "bun-version", status: Bun.semver.satisfies(Bun.version, ">=1.3.0") ? "PASS" : "FAIL" },
    { name: "zstd", status: findBinary("zstd") ? "PASS" : "FAIL" },
    ...(configuration
      ? [
          { name: `skillhub-page-concurrency=${configuration.skillhubPageConcurrency}`, status: "PASS" as const },
          { name: `skillhub-metadata-concurrency=${configuration.skillhubMetadataConcurrency}`, status: "PASS" as const },
          { name: `skillhub-package-concurrency=${configuration.skillhubPackageConcurrency}`, status: "PASS" as const },
          { name: `skillhub-publish-batch=${configuration.skillhubPublishBatch}`, status: "PASS" as const },
          { name: `skillhub-publish-minutes=${configuration.skillhubPublishMinutes}`, status: "PASS" as const },
          { name: `skillhub-memory-soft-limit-mb=${configuration.skillhubMemorySoftLimitMb}`, status: "PASS" as const },
          { name: `skillhub-evaluation-concurrency=${configuration.skillhubEvaluationConcurrency}`, status: "PASS" as const },
          {
            name: `skillhub-evaluation-requests-per-minute=${configuration.skillhubEvaluationRequestsPerMinute}`,
            status: "PASS" as const,
          },
          { name: `skillhub-evaluation-refresh-days=${configuration.skillhubEvaluationRefreshDays}`, status: "PASS" as const },
          { name: `skillhub-evaluation-publish-batch=${configuration.skillhubEvaluationPublishBatch}`, status: "PASS" as const },
        ]
      : []),
  ]
  if (!configuration)
    return [
      ...checks,
      ...["oss-prefixes", "oss-endpoint", "external-proxy", "sso", "sso-identity", "department", "catalog", "web"].map(
        (name) => ({ name, status: "SKIP" as const }),
      ),
    ]

  return [
    ...checks,
    { name: "oss-prefixes", status: "PASS" },
    await probeCheck("oss-endpoint", configuration.ossEndpoint, probe),
    options.environment.HTTPS_PROXY
      ? await probeCheck("external-proxy", configuration.skillhubBaseUrl, probe)
      : { name: "external-proxy", status: "SKIP" },
    await probeCheck("sso", configuration.ssoLoginUrl, probe),
    await probeCheck("sso-identity", configuration.ssoCheckTokenUrl, probe),
    await probeCheck("department", configuration.departmentLookupUrl, probe),
    await probeCheck("catalog", new URL("/v1/catalog/skills", configuration.apiPublicUrl).href, probe),
    await probeCheck("web", configuration.webOrigin, probe),
  ]
}

export async function runSmoke(options: { readonly apiUrl: string; readonly webOrigin: string }) {
  const api = origin(options.apiUrl, "smoke API URL")
  const web = origin(options.webOrigin, "smoke Web origin")
  return Promise.all([
    httpCheck("health", async () => {
      const response = await fetch(new URL("/health", api))
      const body = await response.json()
      return response.ok && body?.status === "ok" && body?.ready === true
    }),
    httpCheck("catalog-cors", async () => {
      const responses = await Promise.all(
        ["GET", "HEAD", "OPTIONS"].map((method) => fetch(new URL("/v1/catalog/skills", api), { method })),
      )
      return responses.every(
        (response) => response.status >= 200 && response.status < 300 && response.headers.get("access-control-allow-origin") === "*",
      )
    }),
    httpCheck("anonymous-session", async () => {
      const response = await fetch(new URL("/v1/auth/session", api), { headers: { origin: web.origin } })
      const body = await response.json()
      return (
        response.ok &&
        (body === null || (typeof body === "object" && typeof body.user === "object")) &&
        response.headers.get("cache-control") === "no-store" &&
        response.headers.get("access-control-allow-origin") === web.origin &&
        response.headers.get("access-control-allow-credentials") === "true"
      )
    }),
    httpCheck("off-origin-write", async () => {
      const response = await fetch(new URL("/v1/submissions", api), {
        method: "POST",
        headers: { origin: "https://off-origin.invalid", "content-type": "application/json", "x-csrf-token": "invalid" },
        body: "{}",
      })
      const body = await response.text()
      return response.status >= 400 && response.status < 500 && !body.toLocaleLowerCase().includes("stack")
    }),
    httpCheck("restricted-cache", async () => {
      const paths = [
        "/v1/restricted-skills",
        "/v1/restricted-skills/pub_preflight",
        "/v1/restricted-skills/pub_preflight/versions",
        "/v1/restricted-skills/pub_preflight/install-grants",
        "/v1/restricted-skills/pub_preflight/download",
        "/v1/restricted-skills/pub_missing01",
      ]
      const responses = await Promise.all(paths.map((path) => fetch(new URL(path, api))))
      return (
        responses.every((response) =>
          response.headers
            .get("cache-control")
            ?.split(",")
            .map((value) => value.trim())
            .includes("no-store"),
        ) &&
        responses.at(-1)?.status === 404
      )
    }),
  ])
}

export async function runPrivateCanary(options: {
  readonly privatePrefix: string
  readonly allow: boolean
  readonly store: {
    readonly putPrivate: (
      key: string,
      body: AsyncIterable<Uint8Array>,
      contentType: string,
      metadata?: Readonly<Record<string, string>>,
    ) => Promise<void>
    readonly get: (key: string) => Promise<Uint8Array>
    readonly head: (key: string) => Promise<{ readonly size: number }>
    readonly delete: (key: string) => Promise<void>
  }
}) {
  if (!options.allow) throw new Error("private canary requires explicit permission")
  const prefix = normalizePrefix(options.privatePrefix)
  const key = `${prefix}/canary/${crypto.randomUUID()}`
  const body = crypto.getRandomValues(new Uint8Array(32))
  await options.store.putPrivate(key, chunks(body), "application/octet-stream")
  try {
    const [metadata, downloaded] = await Promise.all([options.store.head(key), options.store.get(key)])
    if (metadata.size !== body.byteLength || !Bun.deepEquals(downloaded, body)) throw new Error("private canary failed")
  } finally {
    await options.store.delete(key)
  }
  try {
    await options.store.head(key)
  } catch (error) {
    if (isExplicitMissingObjectError(error)) return { name: "private-canary", status: "PASS" as const }
    throw new Error("private canary cleanup failed")
  }
  throw new Error("private canary cleanup failed")
}

export function formatChecks(checks: ReadonlyArray<DeploymentCheck>) {
  return checks.map((check) => `${check.status} ${check.name}`).join("\n")
}

function configured(environment: Environment) {
  try {
    return loadConfig(environment)
  } catch {
    return undefined
  }
}

async function fileCheck(path: string): Promise<DeploymentCheck> {
  const safe = await stat(path).then(
    (metadata) => metadata.isFile() && (metadata.mode & 0o027) === 0,
    () => false,
  )
  return { name: "environment-file", status: safe ? "PASS" : "FAIL" }
}

async function databaseDirectoryCheck(path: string | undefined) {
  return directoryCheck(path && dirname(path), "database-directory")
}

async function directoryCheck(path: string | undefined, name: string): Promise<DeploymentCheck> {
  if (!path) return { name, status: "FAIL" }
  const writable = await Promise.all([stat(path), access(path, constants.W_OK)]).then(
    ([metadata]) => metadata.isDirectory(),
    () => false,
  )
  return { name, status: writable ? "PASS" : "FAIL" }
}

async function probeCheck(name: string, url: string, probe: (url: string) => Promise<boolean>) {
  return { name, status: (await probe(url)) ? ("PASS" as const) : ("FAIL" as const) }
}

async function httpCheck(name: string, check: () => Promise<boolean>): Promise<DeploymentCheck> {
  const passed = await check().then(
    (value) => value,
    () => false,
  )
  return { name, status: passed ? "PASS" : "FAIL" }
}

function probeUrl(url: string) {
  return fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5_000) }).then(
    (response) => response.status < 500,
    () => false,
  )
}

function origin(value: string, name: string) {
  if (!URL.canParse(value)) throw new Error(`${name} must be an HTTP or HTTPS origin`)
  const url = new URL(value)
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`${name} must be an HTTP or HTTPS origin`)
  return url
}

function normalizePrefix(value: string) {
  const prefix = value.replace(/^\/+|\/+$/g, "")
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("private canary prefix is invalid")
  return prefix
}

async function* chunks(body: Uint8Array) {
  yield body
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode !== "preflight" && mode !== "smoke") throw new Error("deploy-check mode must be preflight or smoke")
  const environmentFile = process.env.SKILL_MARKET_ENV_FILE ?? "/etc/ruying-skill-market/market.env"
  if (mode === "preflight") {
    const checks = await runPreflight({ environment: process.env, environmentFile })
    console.log(formatChecks(checks))
    if (checks.some((check) => check.status === "FAIL")) process.exitCode = 1
  } else {
    const config = loadConfig()
    const checks = await runSmoke({ apiUrl: config.apiPublicUrl, webOrigin: config.webOrigin })
    if (process.argv.includes("--allow-private-canary")) {
      const { makeS3ObjectStore } = await import("../src/oss")
      checks.push(
        await runPrivateCanary({
          privatePrefix: config.privateOssPrefix,
          allow: true,
          store: makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket }),
        }),
      )
    }
    console.log(formatChecks(checks))
    if (checks.some((check) => check.status === "FAIL")) process.exitCode = 1
  }
}
