import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { createServer, type ServerResponse } from "http"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { homedir, tmpdir } from "os"
import open from "open"
import { escapeHtml } from "@/util/html"

// 如影 (Ruying) coding gateway SSO login. Ported from the chelper CLI
// (aicoding-helper, src/commands/login.ts + core/gateway.ts). Flow:
//   1. Browser → GWM SSO (sso.gwm.cn?mode=TOKEN) → loopback callback with access_token
//   2. POST aicoding-admin.gwm.cn/api/provision/token { ssoAccessToken } — the
//      admin service validates the SSO token server-side, finds/creates the
//      employee's gateway token, and returns the real sk- key (or a pending
//      status when an admin still has to enable it). No client admin token.
//   3. check_token (auth.paas.gwm.cn) for the employee id / display name (badge).
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
const DEFAULT_CHECK_TOKEN_URL =
  process.env["RUYING_CHECK_TOKEN_URL"] ?? "http://auth.paas.gwm.cn/authenticate/check_token"
const DEFAULT_PLATFORM_CODE = process.env["RUYING_PLATFORM_CODE"] ?? "6533f020e78fcae0e8a28222e49fa558"
// Admin provisioning service (exchanges the SSO token for a gateway key).
const DEFAULT_ADMIN_API_BASE = process.env["RUYING_ADMIN_API"] ?? "https://aicoding-admin.gwm.cn"
// The actual openai-compatible gateway (models + provider baseURL).
const DEFAULT_GATEWAY_API_BASE = process.env["RUYING_GATEWAY_API"] ?? "https://aicoding.gwm.cn/v1"

// GWM SSO accepts an arbitrary loopback redirect_url (chelper passes it
// dynamically), so we bind a short-lived callback server on 127.0.0.1. The port
// is overridable in case 9527 is taken.
const DEFAULT_CALLBACK_HOST = "127.0.0.1"
const DEFAULT_CALLBACK_PORT = Number(process.env["RUYING_CALLBACK_PORT"] ?? 9527)
const OAUTH_REDIRECT_PATH = "/callback"
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const HTTP_TIMEOUT_MS = 20_000
const MODELS_FETCH_TIMEOUT_MS = 15_000

export interface RuyingAuthPluginOptions {
  ssoLoginUrl?: string
  checkTokenUrl?: string
  platformCode?: string
  adminApiBase?: string
  gatewayApiBase?: string
  callbackHost?: string
  callbackPort?: number
  callbackTimeoutMs?: number
  /** Override the global config file path (tests). Defaults to the xdg config. */
  configFile?: string
}

export interface RuyingUser {
  employeeId: string
  displayName: string
  email: string
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
  process: (token: string) => Promise<Outcome>
  resolve: (outcome: Outcome) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let oauthServerPort: number | undefined
let pending: Pending | undefined

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function userAgent() {
  return `opencode/${InstallationVersion}`
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
// so we can derive the badge user from the provision result when check_token is
// unavailable.
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
    <title>opencode - 如影 SSO 登录成功</title>
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
      <p>可以关闭此窗口并返回 opencode。</p>
    </div>
    <script>setTimeout(() => window.close(), 2000)</script>
  </body>
</html>`

const htmlNotice = (title: string, message: string) => `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>opencode - ${escapeHtml(title)}</title>
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

async function startOAuthServer(
  host: string,
  requestedPort: number,
  fallbackToEphemeral: boolean,
): Promise<{ port: number }> {
  if (oauthServer && oauthServerPort !== undefined) return { port: oauthServerPort }

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host ?? `${host}:${oauthServerPort ?? requestedPort}`}`)
    if (url.pathname !== OAUTH_REDIRECT_PATH) {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    const current = pending
    if (!current) {
      endHtml(res, 409, htmlNotice("登录失败", "没有进行中的登录请求，请在 opencode 中重新发起。"))
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
      endHtml(res, 200, outcome.ok ? HTML_SUCCESS : htmlNotice(outcome.title, outcome.message))
      current.resolve(outcome)
    })()
  })

  return await new Promise<{ port: number }>((resolve, reject) => {
    const onError = (err: Error) => {
      oauthServer = undefined
      oauthServerPort = undefined
      const occupied = (err as NodeJS.ErrnoException).code === "EADDRINUSE"
      if (occupied && fallbackToEphemeral) {
        void startOAuthServer(host, 0, false).then(resolve, reject)
        return
      }
      reject(occupied ? new Error(`端口 ${requestedPort} 已被占用，请关闭占用程序后重试`) : err)
    }
    server.once("error", onError)
    server.listen(requestedPort, host, () => {
      server.removeListener("error", onError)
      const address = server.address()
      oauthServerPort = address && typeof address !== "string" ? address.port : requestedPort
      resolve({ port: oauthServerPort })
    })
    oauthServer = server
  })
}

function stopOAuthServer() {
  if (!oauthServer) return
  oauthServer.close()
  oauthServer = undefined
  oauthServerPort = undefined
}

function setPending(
  input: { process: Pending["process"]; resolve: Pending["resolve"]; reject: Pending["reject"] },
  timeoutMs: number,
) {
  // Reject any abandoned in-flight attempt so its caller stops waiting.
  if (pending) {
    pending.reject(new Error("被新的登录请求取代"))
    pending = undefined
  }
  const timeout = setTimeout(() => {
    if (pending) {
      const current = pending
      pending = undefined
      current.reject(new Error("登录超时，请重新发起登录"))
    }
  }, timeoutMs)
  pending = {
    process: input.process,
    resolve: (outcome) => {
      clearTimeout(timeout)
      input.resolve(outcome)
    },
    reject: (err) => {
      clearTimeout(timeout)
      input.reject(err)
    },
  }
}

// SSO access_token -> gateway API key, via the admin provisioning service.
export async function provisionToken(adminApiBase: string, ssoAccessToken: string): Promise<ProvisionResult> {
  const res = await fetch(`${stripTrailingSlash(adminApiBase)}/api/provision/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": userAgent() },
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

// SSO access_token -> user info, via GWM PaaS check_token (best-effort badge info).
export async function verifyAccessToken(
  checkTokenUrl: string,
  platformCode: string,
  accessToken: string,
): Promise<RuyingUser> {
  if (!accessToken) throw new Error("access_token 为空")
  const url = `${checkTokenUrl}?access_token=${encodeURIComponent(accessToken)}&platform_code=${encodeURIComponent(platformCode)}`
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": userAgent() },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`SSO 校验失败 (check_token HTTP ${res.status})`)
  const body = (await res.json().catch(() => undefined)) as
    | { key?: string; result?: { user_code?: string; user_name?: string; email?: string } }
    | undefined
  if (!body || body.key !== "S_0000") throw new Error(`SSO 校验被拒绝: key=${body?.key ?? "未知"}`)
  const result = body.result ?? {}
  const employeeId = (result.user_code ?? "").trim()
  if (!employeeId) throw new Error("SSO 返回缺少工号 (user_code)")
  return {
    employeeId,
    displayName: (result.user_name ?? "").trim(),
    email: (result.email ?? "").trim(),
  }
}

// Best-effort: list available gateway models so they can be written into the
// provider config. Failure is non-fatal — login still succeeds without models.
export async function fetchModelIds(gatewayApiBase: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${stripTrailingSlash(gatewayApiBase)}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": userAgent() },
    signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) return []
  const body = (await res.json().catch(() => undefined)) as { data?: Array<{ id?: unknown }> } | undefined
  return (body?.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === "string" && id.length > 0)
}

// Resolve the global opencode config file (xdg config dir), preferring an
// existing one among the recognized names.
export function globalConfigFile(): string {
  const dir = join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "opencode")
  for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return join(dir, "opencode.json")
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
): void {
  let config: Record<string, any> = {}
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      return // don't clobber a config we can't parse (e.g. jsonc with comments)
    }
  } else {
    mkdirSync(dirname(file), { recursive: true })
  }
  config["enabled_providers"] = [PROVIDER_ID]
  const patch = buildProviderPatch(gatewayApiBase, modelIds, user).provider[PROVIDER_ID]
  const providers: Record<string, any> = (config["provider"] ??= {})
  const existing: Record<string, any> = providers[PROVIDER_ID] ?? {}
  providers[PROVIDER_ID] = {
    ...existing,
    ...patch,
    // Keep any pre-existing options (e.g. chelper's apiKey) and add ours.
    options: { ...(existing["options"] ?? {}), ...patch.options },
  }
  writeFileSync(file, JSON.stringify(config, null, 2))
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
  const ruyingUser = user
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
  const checkTokenUrl = options.checkTokenUrl ?? DEFAULT_CHECK_TOKEN_URL
  const platformCode = options.platformCode ?? DEFAULT_PLATFORM_CODE
  const adminApiBase = stripTrailingSlash(options.adminApiBase ?? DEFAULT_ADMIN_API_BASE)
  const gatewayApiBase = stripTrailingSlash(options.gatewayApiBase ?? DEFAULT_GATEWAY_API_BASE)
  const callbackHost = options.callbackHost ?? DEFAULT_CALLBACK_HOST
  const callbackPort = options.callbackPort ?? DEFAULT_CALLBACK_PORT
  const callbackTimeoutMs = options.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS

  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "oauth",
          label: "如影 SSO 登录 (浏览器)",
          async authorize() {
            const { port } = await startOAuthServer(
              callbackHost,
              callbackPort,
              options.callbackPort === undefined && callbackPort === 9527,
            )
            const redirectUri = `http://${callbackHost}:${port}${OAUTH_REDIRECT_PATH}`

            const outcomePromise = new Promise<Outcome>((resolve, reject) => {
              setPending({
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
                    // Badge user: prefer check_token, fall back to the token name.
                    let user = parseUserFromTokenName(result.tokenName)
                    try {
                      user = await verifyAccessToken(checkTokenUrl, platformCode, ssoToken)
                      debug(`[ruying] check_token ok employeeId=${user.employeeId} name=${user.displayName}`)
                    } catch (e) {
                      debug(`[ruying] check_token error: ${e instanceof Error ? e.message : String(e)}`)
                      // check_token best-effort; keep the name parsed from tokenName.
                    }
                    debug(`[ruying] final user employeeId=${JSON.stringify(user.employeeId)} name=${JSON.stringify(user.displayName)}`)
                    return { ok: true, key: result.key, user }
                  }

                  // 2. Provisioning is down (e.g. aicoding-admin 503). Verify the SSO
                  // login via check_token, then fall back to an existing gateway key in
                  // the config (e.g. one chelper already provisioned) so login still
                  // works while the provisioning service is unavailable.
                  let user: RuyingUser
                  try {
                    user = await verifyAccessToken(checkTokenUrl, platformCode, ssoToken)
                    debug(`[ruying] fallback check_token ok employeeId=${user.employeeId} name=${user.displayName}`)
                  } catch (e) {
                    debug(`[ruying] fallback check_token error: ${e instanceof Error ? e.message : String(e)}`)
                    return {
                      ok: false,
                      title: "开通失败",
                      message: `网关开通服务暂不可用（${provisionError?.message ?? "503"}），且无法校验登录，请稍后重试。`,
                    }
                  }
                  const existingKey = readExistingRuyingKey(options.configFile ?? globalConfigFile())
                  debug(`[ruying] fallback existingKey=${existingKey ? "present" : "missing"}`)
                  if (!existingKey) {
                    return {
                      ok: false,
                      title: "开通失败",
                      message: `网关开通服务暂不可用（${provisionError?.message ?? "503"}）。请稍后重试，或先用 chelper 开通一次。`,
                    }
                  }
                  return { ok: true, key: existingKey, user }
                },
                resolve,
                reject,
              }, callbackTimeoutMs)
            })

            const url = buildSsoUrl(ssoLoginUrl, redirectUri)
            await open(url).catch(() => undefined)

            return {
              url,
              instructions: "请在浏览器完成 GWM SSO 登录，opencode 会自动捕获回调并开通网关 API Key。",
              method: "auto" as const,
              async callback() {
                try {
                  const outcome = await outcomePromise
                  debug(`[ruying] callback outcome ok=${outcome.ok}`)
                  if (!outcome.ok) return { type: "failed" as const }

                  const modelIds = await fetchModelIds(gatewayApiBase, outcome.key).catch(() => [] as string[])
                  debug(
                    `[ruying] callback modelIds=${modelIds.length} user=${JSON.stringify(outcome.user ?? null)}`,
                  )
                  // Restrict the app to only the 如影 gateway, and register it + the
                  // logged-in user. Written to disk directly (not via the SDK) so we
                  // don't dispose the instance mid-callback; the gate re-bootstraps.
                  try {
                    writeGlobalProviderConfig(
                      options.configFile ?? globalConfigFile(),
                      gatewayApiBase,
                      modelIds,
                      outcome.user,
                    )
                  } catch {
                    // best-effort
                  }

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
                  stopOAuthServer()
                }
              },
            }
          },
        },
      ],
    },
  }
}
