import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { createServer, type ServerResponse } from "http"
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "fs"
import { chmod, rename, rm, stat, writeFile } from "fs/promises"
import { basename, dirname, join, resolve } from "path"
import { tmpdir } from "os"
import open from "open"
import { escapeHtml } from "@/util/html"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import { ConfigPaths } from "@/config/paths"
import { Brand } from "@opencode-ai/core/brand/brand"

// 如影 (Ruying) coding gateway SSO login. Ported from the chelper CLI
// (aicoding-helper, src/commands/login.ts + core/gateway.ts). Flow:
//   1. Browser → GWM SSO (sso.gwm.cn?mode=TOKEN) → loopback callback with access_token
//   2. POST aicoding-admin.gwm.cn/api/provision/token { ssoAccessToken } — the
//      admin service validates the SSO token server-side, finds/creates the
//      employee's gateway token, and returns the real sk- key (or a pending
//      status when an admin still has to enable it). No client admin token.
//   3. Require employee identity from the authenticated provisioning result.
//   4. Fetch /v1/models and register the openai-compatible gateway provider.
//
// The token→key exchange runs inside the loopback handler so the browser page
// shows the real outcome (success / pending admin enable / error), while
// callback() only ever resolves to success|failed — never throws (the TUI
// `/connect` path runs callback() through Effect.promise, which would turn a
// thrown error into an unrecoverable defect).

const PROVIDER_ID = "ruying"
const PROVIDER_NAME = "如影编码网关"
const PROVIDER_NPM = "@ai-sdk/openai-compatible"

// Defaults match the chelper reference; overridable by env so the same plugin
// can target staging / a self-hosted gateway, and by options for tests.
const DEFAULT_SSO_LOGIN_URL = process.env["RUYING_SSO_URL"] ?? "https://sso.gwm.cn/login"
// Admin provisioning service (exchanges the SSO token for a gateway key).
const DEFAULT_ADMIN_API_BASE = process.env["RUYING_ADMIN_API"] ?? "https://aicoding-admin.gwm.cn"
// The actual openai-compatible gateway (models + provider baseURL).
const DEFAULT_GATEWAY_API_BASE = process.env["RUYING_GATEWAY_API"] ?? "https://aicoding.gwm.cn/v1"

// GWM SSO accepts an arbitrary loopback redirect_url (chelper passes it
// dynamically), so we bind a short-lived callback server on 127.0.0.1. The port
// is overridable in case 9527 is taken.
const DEFAULT_CALLBACK_HOST = "127.0.0.1"
const DEFAULT_CALLBACK_PORT = 9527
const OAUTH_REDIRECT_PATH = "/callback"
const OAUTH_SERVER_CONFIG_MISMATCH = "如影登录回调服务器配置不匹配，请等待当前登录结束后重试"
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const HTTP_TIMEOUT_MS = 20_000
const MODELS_FETCH_TIMEOUT_MS = 15_000

export interface RuyingAuthPluginOptions {
  ssoLoginUrl?: string
  adminApiBase?: string
  gatewayApiBase?: string
  callbackHost?: string
  callbackPort?: number
  callbackTimeoutMs?: number
  /** Override the global config file path (tests). Defaults to the xdg config. */
  configFile?: string
  configPublicationHooks?: {
    beforeRename?(): Promise<void>
    afterRename?(): Promise<void>
  }
}

export interface RuyingUser {
  employeeId: string
  displayName: string
  email: string
}

export class RuyingConfigPublicationError extends Error {
  constructor(
    readonly file: string,
    readonly reason: "invalid-jsonc" | "non-object",
  ) {
    super(`Cannot publish Ruying provider config: ${reason} (${file})`)
    this.name = "RuyingConfigPublicationError"
  }
}

// Result of POST /api/provision/token. The admin service either returns a ready
// key or reports that the token is awaiting admin enablement.
export type ProvisionResult =
  | { status: "ready"; key: string; tokenName?: string }
  | { status: "pending_enable"; tokenName?: string; reason?: string }

// Outcome of exchanging the SSO token, computed inside the loopback handler so
// the browser page reflects it. callback() maps this to success|failed.
type Outcome = { ok: true; key: string; user: RuyingUser } | { ok: false; title: string; message: string }

interface Pending {
  id: string
  path: string
  process: (token: string) => Promise<Outcome>
  resolve: (outcome: Outcome) => void
  reject: (error: Error) => void
  canceled: () => boolean
}

interface OAuthServerBinding {
  host: string
  requestedPort: number
  fallbackToEphemeral: boolean
}

interface OAuthServerStart {
  binding: OAuthServerBinding
  promise: Promise<{ port: number }>
}

let oauthServer: ReturnType<typeof createServer> | undefined
let oauthServerPort: number | undefined
let oauthServerGeneration: OAuthServerStart | undefined
let oauthServerStart: OAuthServerStart | undefined
let oauthServerOwner: string | undefined
let pending: Pending | undefined
const providerConfigWrites = new Map<string, Promise<void>>()

interface OwnedConfigValue {
  path: string[]
  present: boolean
  value?: unknown
}

interface OwnedConfigSnapshot {
  fileExisted: boolean
  enabled: OwnedConfigValue
  values: OwnedConfigValue[]
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

export function ruyingUserAgent() {
  return `${Brand.profile.cliName}/${InstallationVersion}`
}

// Diagnostic log to a temp file (disable with RUYING_DEBUG=0). Helps trace why
// the SSO user / models came back empty when login looks stuck.
function debug(message: string): void {
  if (process.env["RUYING_DEBUG"] === "0") return
  try {
    appendFileSync(join(tmpdir(), "ruying-debug.log"), message + "\n")
  } catch {
    // ignore
  }
}

export function buildSsoUrl(ssoLoginUrl: string, redirectUri: string): string {
  return `${ssoLoginUrl}?mode=TOKEN&redirect_url=${encodeURIComponent(redirectUri)}`
}

// Token names follow "{EMPLOYEE_ID}-{display name}" (e.g. "GW00178937-武晓达"),
// The provisioning service has already authenticated the SSO token, so its
// token name is the authoritative client-safe identity source.
export function parseUserFromTokenName(tokenName: string | undefined): RuyingUser {
  const name = (tokenName ?? "").trim()
  const idx = name.indexOf("-")
  if (idx <= 0) return { employeeId: name, displayName: "", email: "" }
  return { employeeId: name.slice(0, idx), displayName: name.slice(idx + 1), email: "" }
}

const HTML_SUCCESS = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>如影 Code - SSO 登录成功</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0b1220; color: #e8eef9; }
      .container { text-align: center; padding: 2rem; }
      h1 { color: #7ee787; margin-bottom: 1rem; }
      p { color: #9aa9c0; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>登录成功</h1>
      <p>可以关闭此窗口并返回 如影 Code。</p>
    </div>
    <script>setTimeout(() => window.close(), 2000)</script>
  </body>
</html>`

const htmlNotice = (title: string, message: string) => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>如影 Code - ${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0b1220; color: #e8eef9; }
      .container { text-align: center; padding: 2rem; max-width: 36rem; }
      h1 { color: #ffd479; margin-bottom: 1rem; }
      .message { color: #ffe6b3; font-family: monospace; margin-top: 1rem; padding: 1rem; background: #2a2410; border-radius: 0.5rem; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>${escapeHtml(title)}</h1>
      <div class="message">${escapeHtml(message)}</div>
    </div>
  </body>
</html>`

function endHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
  res.end(html)
}

function startOAuthServer(
  host: string,
  requestedPort: number,
  fallbackToEphemeral: boolean,
): Promise<{ port: number }> {
  const binding = { host, requestedPort, fallbackToEphemeral }
  if (oauthServer && oauthServerPort !== undefined) {
    if (oauthServerGeneration && sameOAuthServerBinding(oauthServerGeneration.binding, binding)) {
      return Promise.resolve({ port: oauthServerPort })
    }
    return Promise.reject(new Error(OAUTH_SERVER_CONFIG_MISMATCH))
  }
  if (oauthServerStart) {
    if (sameOAuthServerBinding(oauthServerStart.binding, binding)) return oauthServerStart.promise
    return Promise.reject(new Error(OAUTH_SERVER_CONFIG_MISMATCH))
  }

  const deferred = Promise.withResolvers<{ port: number }>()
  const start = { binding, promise: deferred.promise }
  oauthServerStart = start
  void listenOAuthServer(host, requestedPort, fallbackToEphemeral, start).then(deferred.resolve, deferred.reject)
  const clearStart = () => {
    if (oauthServerStart === start) oauthServerStart = undefined
  }
  void deferred.promise.then(clearStart, clearStart)
  return deferred.promise
}

function sameOAuthServerBinding(left: OAuthServerBinding, right: OAuthServerBinding) {
  return (
    left.host === right.host &&
    left.requestedPort === right.requestedPort &&
    left.fallbackToEphemeral === right.fallbackToEphemeral
  )
}

function listenOAuthServer(
  host: string,
  requestedPort: number,
  fallbackToEphemeral: boolean,
  start: OAuthServerStart,
): Promise<{ port: number }> {
  const server = createServer((req, res) => {
    const address = server.address()
    const port = address && typeof address !== "string" ? address.port : requestedPort
    const url = new URL(req.url || "/", `http://${req.headers.host ?? `${host}:${port}`}`)
    const current = pending
    if (!current || url.pathname !== current.path) {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    pending = undefined

    const error = url.searchParams.get("error")
    // mode=TOKEN returns the SSO access token directly on the redirect.
    const token = url.searchParams.get("access_token") || url.searchParams.get("token")

    if (error || !token) {
      const message = error || "SSO 回调缺少 access_token"
      endHtml(res, error ? 200 : 400, htmlNotice("登录失败", message))
      current.resolve({ ok: false, title: "登录失败", message })
      return
    }

    // Exchange the SSO token for a gateway key here so the browser page can show
    // the real result. Any thrown error becomes a failed outcome (never crashes).
    void (async () => {
      let outcome: Outcome
      try {
        outcome = await current.process(token)
      } catch (err) {
        outcome = { ok: false, title: "登录失败", message: err instanceof Error ? err.message : String(err) }
      }
      if (current.canceled()) outcome = { ok: false, title: "登录已取消", message: "请返回终端重新发起登录" }
      endHtml(res, 200, outcome.ok ? HTML_SUCCESS : htmlNotice(outcome.title, outcome.message))
      current.resolve(outcome)
    })()
  })

  return new Promise<{ port: number }>((resolve, reject) => {
    const onError = (err: Error) => {
      clearOAuthServer(server, start)
      const occupied = (err as NodeJS.ErrnoException).code === "EADDRINUSE"
      if (occupied && fallbackToEphemeral) {
        void listenOAuthServer(host, 0, false, start).then(resolve, reject)
        return
      }
      reject(occupied ? new Error(`端口 ${requestedPort} 已被占用，请关闭占用程序后重试`) : err)
    }
    server.once("error", onError)
    server.listen(requestedPort, host, () => {
      server.removeListener("error", onError)
      if (oauthServerStart !== start) {
        server.close()
        reject(new Error("登录服务器启动已过期"))
        return
      }
      const address = server.address()
      const port = address && typeof address !== "string" ? address.port : requestedPort
      oauthServer = server
      oauthServerPort = port
      oauthServerGeneration = start
      resolve({ port })
    })
  })
}

function stopOAuthServer(owner: string) {
  if (oauthServerOwner !== owner) return
  const server = oauthServer
  const generation = oauthServerGeneration
  server?.close()
  if (server && generation) clearOAuthServer(server, generation)
  if (oauthServerOwner !== owner) return
  oauthServerOwner = undefined
}

function clearOAuthServer(server: ReturnType<typeof createServer>, generation: OAuthServerStart) {
  if (oauthServer !== server || oauthServerGeneration !== generation) return
  oauthServer = undefined
  oauthServerPort = undefined
  oauthServerGeneration = undefined
}

function setPending(input: Pending, timeoutMs: number) {
  // Reject any abandoned in-flight attempt so its caller stops waiting.
  if (pending) {
    pending.reject(new Error("被新的登录请求取代"))
    pending = undefined
  }
  oauthServerOwner = input.id
  const timeout = setTimeout(() => {
    if (pending?.id === input.id) {
      const current = pending
      pending = undefined
      current.reject(new Error("登录超时，请重新发起登录"))
    }
  }, timeoutMs)
  pending = {
    id: input.id,
    path: input.path,
    process: input.process,
    resolve: (outcome) => {
      clearTimeout(timeout)
      input.resolve(outcome)
    },
    reject: (err) => {
      clearTimeout(timeout)
      input.reject(err)
    },
    canceled: input.canceled,
  }
}

// SSO access_token -> gateway API key, via the admin provisioning service.
export async function provisionToken(adminApiBase: string, ssoAccessToken: string): Promise<ProvisionResult> {
  const res = await fetch(`${stripTrailingSlash(adminApiBase)}/api/provision/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": ruyingUserAgent() },
    body: JSON.stringify({ ssoAccessToken }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!res.ok) {
    if (res.status === 401) throw new Error("SSO 校验失败，请重新登录")
    if (res.status === 429) throw new Error("请求过于频繁，请稍后再试")
    const detail = await res.text().catch(() => "")
    throw new Error(`开通失败 (${res.status})${detail ? `: ${detail}` : ""}`)
  }
  return (await res.json()) as ProvisionResult
}

// Best-effort: list available gateway models so they can be written into the
// provider config. Failure is non-fatal — login still succeeds without models.
export async function fetchModelIds(gatewayApiBase: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${stripTrailingSlash(gatewayApiBase)}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": ruyingUserAgent() },
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) return []
  const body = (await res.json().catch(() => undefined)) as { data?: Array<{ id?: unknown }> } | undefined
  return (body?.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === "string" && id.length > 0)
}

// Resolve the effective global branded config file, matching Config's load precedence.
export function globalConfigFile(directory = Global.Path.config): string {
  const candidates = [
    ...ConfigPaths.globalConfigNames.toReversed().flatMap((name) => [`${name}.jsonc`, `${name}.json`]),
    "config.json",
  ].map((name) => join(directory, name))
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

// Write the ruying provider + logged-in user into the global config FILE directly
// (like chelper). We deliberately do NOT use the SDK config endpoint: that goes
// through updateGlobal → disposeAllInstancesAndEmitGlobalDisposed, which would
// dispose the instance mid auth-callback and hang the login. The change is read
// on the gate's post-login re-bootstrap.
export function writeGlobalProviderConfig(
  file: string,
  gatewayApiBase: string,
  modelIds: string[],
  user: RuyingUser,
): Promise<void> {
  return createRuyingConfigPublication(file, gatewayApiBase, modelIds, user).publish()
}

function createRuyingConfigPublication(
  file: string,
  gatewayApiBase: string,
  modelIds: string[],
  user: RuyingUser,
  hooks: RuyingAuthPluginOptions["configPublicationHooks"] = {},
) {
  const requested = resolve(file)
  const target = existsSync(requested) ? realpathSync(requested) : requested
  let canceled = false
  let published = false
  let snapshot: OwnedConfigSnapshot | undefined
  let publication: Promise<void> | undefined
  let cancellation: Promise<void> | undefined

  function publish() {
    if (publication) return publication
    publication = queueProviderConfigWrite(target, async () => {
      if (canceled) return
      const edit = await providerConfigEdit(target, gatewayApiBase, modelIds, user)
      if (!edit) return
      snapshot = edit.snapshot
      const temporary = await writeTemporaryConfig(target, edit.output, edit.mode)
      await hooks.beforeRename?.()
      if (canceled) {
        await rm(temporary, { force: true })
        return
      }
      await rename(temporary, target)
      published = true
      await hooks.afterRename?.()
      if (!canceled) return
      await restoreOwnedConfig(target, edit.snapshot)
      published = false
    })
    return publication
  }

  function cancel() {
    canceled = true
    if (cancellation) return cancellation
    cancellation = (async () => {
      await publication?.catch(() => undefined)
      if (!published || !snapshot) return
      await queueProviderConfigWrite(target, async () => {
        if (!published || !snapshot) return
        await restoreOwnedConfig(target, snapshot)
        published = false
      })
    })()
    return cancellation
  }

  return { publish, cancel }
}

function queueProviderConfigWrite(target: string, task: () => Promise<void>) {
  const previous = providerConfigWrites.get(target) ?? Promise.resolve()
  const write = previous.catch(() => undefined).then(task)
  const queued = write.finally(() => {
    if (providerConfigWrites.get(target) === queued) providerConfigWrites.delete(target)
  })
  providerConfigWrites.set(target, queued)
  return queued
}

async function providerConfigEdit(file: string, gatewayApiBase: string, modelIds: string[], user: RuyingUser) {
  const exists = existsSync(file)
  const source = exists ? await Bun.file(file).text() : "{}"
  const errors: ParseError[] = []
  const config: unknown = parse(source, errors, { allowTrailingComma: true })
  if (errors.length) throw new RuyingConfigPublicationError(file, "invalid-jsonc")
  if (!isRecord(config)) throw new RuyingConfigPublicationError(file, "non-object")
  if (!exists) mkdirSync(dirname(file), { recursive: true })

  const provider = buildProviderPatch(gatewayApiBase, modelIds, user).provider[PROVIDER_ID]
  const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
  const edits = [
    { path: ["provider", PROVIDER_ID, "name"], value: provider.name },
    { path: ["provider", PROVIDER_ID, "npm"], value: provider.npm },
    ...(provider.models ? [{ path: ["provider", PROVIDER_ID, "models"], value: provider.models }] : []),
    { path: ["provider", PROVIDER_ID, "options", "baseURL"], value: provider.options.baseURL },
    { path: ["provider", PROVIDER_ID, "options", "ruyingUser"], value: provider.options.ruyingUser },
  ]
  const output = [
    {
      path: ["enabled_providers"],
      value: [PROVIDER_ID],
    },
    ...edits,
  ].reduce((result, edit) => applyEdits(result, modify(result, edit.path, edit.value, formatting)), source)
  return {
    output,
    mode: exists ? (await stat(file)).mode & 0o777 : 0o600,
    snapshot: {
      fileExisted: exists,
      enabled: ownedConfigValue(config, ["enabled_providers"]),
      values: edits.map((edit) => ownedConfigValue(config, edit.path)),
    } satisfies OwnedConfigSnapshot,
  }
}

async function writeTemporaryConfig(file: string, output: string, mode: number) {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, output, { encoding: "utf8", flag: "wx", mode })
    .then(() => chmod(temporary, mode))
    .catch(async (error) => {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    })
  return temporary
}

async function restoreOwnedConfig(file: string, snapshot: OwnedConfigSnapshot) {
  if (!existsSync(file)) return
  const source = await Bun.file(file).text()
  const errors: ParseError[] = []
  const config: unknown = parse(source, errors, { allowTrailingComma: true })
  if (errors.length || !isRecord(config)) return
  const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
  const enabled = Array.isArray(config.enabled_providers)
    ? config.enabled_providers.filter((item) => item !== PROVIDER_ID)
    : []
  const previousEnabled = Array.isArray(snapshot.enabled.value) ? snapshot.enabled.value : []
  const restoredEnabled = snapshot.enabled.present
    ? Array.isArray(snapshot.enabled.value)
      ? [...previousEnabled, ...enabled.filter((item) => !previousEnabled.includes(item))]
      : snapshot.enabled.value
    : enabled.length
      ? enabled
      : undefined
  const restored = snapshot.values.reduce(
    (result, item) => applyEdits(result, modify(result, item.path, item.present ? item.value : undefined, formatting)),
    applyEdits(source, modify(source, ["enabled_providers"], restoredEnabled, formatting)),
  )
  const compacted = [["provider", PROVIDER_ID, "options"], ["provider", PROVIDER_ID], ["provider"]].reduce(
    (result, path) => {
      const parsed = parse(result) as Record<string, unknown>
      const value = path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), parsed)
      if (!isRecord(value) || Object.keys(value).length) return result
      return applyEdits(result, modify(result, path, undefined, formatting))
    },
    restored,
  )
  const finalConfig = parse(compacted) as Record<string, unknown>
  if (!snapshot.fileExisted && Object.keys(finalConfig).length === 0) {
    await rm(file, { force: true })
    return
  }
  const mode = (await stat(file)).mode & 0o777
  await writeTemporaryConfig(file, compacted, mode).then((temporary) => rename(temporary, file))
}

function ownedConfigValue(config: Record<string, unknown>, path: string[]): OwnedConfigValue {
  let current: unknown = config
  for (const key of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) return { path, present: false }
    current = current[key]
  }
  return { path, present: true, value: current }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Read an already-provisioned ruying key from the config (e.g. one chelper wrote),
// used as a fallback when the provisioning service is unavailable.
export function readExistingRuyingKey(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined
    const config = JSON.parse(readFileSync(file, "utf8")) as {
      provider?: { ruying?: { options?: { apiKey?: unknown } } }
    }
    const key = config.provider?.ruying?.options?.apiKey
    return typeof key === "string" && key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}

export function buildProviderPatch(gatewayApiBase: string, modelIds: string[], user?: RuyingUser) {
  const models: Record<string, { name: string; modalities: { input: Array<"text">; output: Array<"text"> } }> = {}
  for (const id of modelIds) {
    models[id] = { name: id, modalities: { input: ["text"], output: ["text"] } }
  }
  // Stash the logged-in SSO user under the provider options (an open record) so
  // the desktop UI can show it bottom-left AND so the gate can detect that OUR
  // SSO login happened. Always write it when a user object is provided (even with
  // empty fields) — its presence is the "logged in" marker; the badge shows the
  // name only when the fields are populated.
  const ruyingUser = user?.employeeId.trim()
    ? { ruyingUser: { employeeId: user.employeeId, displayName: user.displayName, email: user.email } }
    : {}
  // No apiKey here — opencode injects the credential stored in auth.json into
  // the provider options automatically (provider.ts merges `source: "api"`).
  return {
    provider: {
      [PROVIDER_ID]: {
        name: PROVIDER_NAME,
        npm: PROVIDER_NPM,
        options: { baseURL: stripTrailingSlash(gatewayApiBase), ...ruyingUser },
        ...(modelIds.length ? { models } : {}),
      },
    },
  }
}

export async function RuyingAuthPlugin(_input: PluginInput, options: RuyingAuthPluginOptions = {}): Promise<Hooks> {
  const ssoLoginUrl = options.ssoLoginUrl ?? DEFAULT_SSO_LOGIN_URL
  const adminApiBase = stripTrailingSlash(options.adminApiBase ?? DEFAULT_ADMIN_API_BASE)
  const gatewayApiBase = stripTrailingSlash(options.gatewayApiBase ?? DEFAULT_GATEWAY_API_BASE)
  const callbackHost = options.callbackHost ?? DEFAULT_CALLBACK_HOST
  const configuredCallbackPort = options.callbackPort ?? process.env["RUYING_CALLBACK_PORT"]
  const callbackPort = Number(configuredCallbackPort ?? DEFAULT_CALLBACK_PORT)
  const callbackTimeoutMs = options.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS

  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "如影 SSO 登录 (浏览器)",
          async authorize() {
            const attemptId = crypto.randomUUID()
            let canceled = false
            let rejectOutcome = (_error: Error) => {}
            let publication: ReturnType<typeof createRuyingConfigPublication> | undefined
            const callbackPath = `${OAUTH_REDIRECT_PATH}/${attemptId}`
            const { port } = await startOAuthServer(callbackHost, callbackPort, configuredCallbackPort === undefined)
            const redirectUri = `http://${callbackHost}:${port}${callbackPath}`

            const outcomePromise = new Promise<Outcome>((resolve, reject) => {
              rejectOutcome = reject
              setPending(
                {
                  id: attemptId,
                  path: callbackPath,
                  async process(ssoToken) {
                    // 1. Try to provision a fresh key from the admin service.
                    let result: ProvisionResult | undefined
                    let provisionError: Error | undefined
                    try {
                      result = await provisionToken(adminApiBase, ssoToken)
                      debug(
                        `[ruying] provision keys=${JSON.stringify(Object.keys(result ?? {}))} status=${result?.status} tokenName=${JSON.stringify((result as { tokenName?: unknown })?.tokenName)}`,
                      )
                    } catch (err) {
                      provisionError = err instanceof Error ? err : new Error(String(err))
                      debug(`[ruying] provision error: ${provisionError.message}`)
                    }

                    if (result) {
                      if (result.status !== "ready" || !result.key) {
                        const name = result.tokenName ?? PROVIDER_NAME
                        return {
                          ok: false,
                          title: "待管理员开通",
                          message: `网关 Token「${name}」已创建但尚未启用，请联系管理员开通使用权限后重新登录。`,
                        }
                      }
                      const user = parseUserFromTokenName(result.tokenName)
                      if (!user.employeeId) {
                        return {
                          ok: false,
                          title: "登录失败",
                          message: "开通服务未返回工号身份，请联系管理员检查 Token 名称。",
                        }
                      }
                      debug(
                        `[ruying] final user employeeId=${JSON.stringify(user.employeeId)} name=${JSON.stringify(user.displayName)}`,
                      )
                      return { ok: true, key: result.key, user }
                    }

                    return {
                      ok: false,
                      title: "开通失败",
                      message: `网关开通服务暂不可用（${provisionError?.message ?? "503"}）。请稍后重试。`,
                    }
                  },
                  resolve,
                  reject,
                  canceled: () => canceled,
                },
                callbackTimeoutMs,
              )
            })
            void outcomePromise.catch(() => undefined)

            const url = buildSsoUrl(ssoLoginUrl, redirectUri)
            await open(url).catch(() => undefined)

            return {
              url,
              instructions: "请在浏览器完成 GWM SSO 登录，如影 Code 会自动捕获回调并开通网关 API Key。",
              method: "auto" as const,
              async cancel() {
                if (canceled) return publication?.cancel()
                canceled = true
                if (pending?.id === attemptId) {
                  const current = pending
                  pending = undefined
                  current.reject(new Error("登录已取消"))
                } else {
                  rejectOutcome(new Error("登录已取消"))
                }
                stopOAuthServer(attemptId)
                await publication?.cancel()
              },
              async callback() {
                try {
                  const outcome = await outcomePromise
                  debug(`[ruying] callback outcome ok=${outcome.ok}`)
                  if (!outcome.ok) return { type: "failed" as const }
                  if (canceled) return { type: "failed" as const }
                  if (!outcome.user.employeeId.trim()) return { type: "failed" as const }

                  const modelIds = await fetchModelIds(gatewayApiBase, outcome.key).catch(() => [] as string[])
                  if (canceled) return { type: "failed" as const }
                  debug(`[ruying] callback modelIds=${modelIds.length} user=${JSON.stringify(outcome.user ?? null)}`)
                  // Restrict the app to only the 如影 gateway, and register it + the
                  // logged-in user. Written to disk directly (not via the SDK) so we
                  // don't dispose the instance mid-callback; the gate re-bootstraps.
                  publication = createRuyingConfigPublication(
                    options.configFile ?? globalConfigFile(),
                    gatewayApiBase,
                    modelIds,
                    outcome.user,
                    options.configPublicationHooks,
                  )
                  await publication.publish().catch(async () => {
                    await publication?.cancel()
                    throw new Error("Failed to publish Ruying provider config")
                  })
                  if (canceled) return { type: "failed" as const }

                  return {
                    type: "success" as const,
                    key: outcome.key,
                    metadata: {
                      employeeId: outcome.user.employeeId,
                      displayName: outcome.user.displayName,
                      email: outcome.user.email,
                    },
                  }
                } catch {
                  // timeout / superseded / unexpected — fail cleanly so neither
                  // the CLI nor the TUI (Effect.promise) crashes.
                  return { type: "failed" as const }
                } finally {
                  stopOAuthServer(attemptId)
                }
              },
            }
          },
        },
      ],
    },
  }
}
