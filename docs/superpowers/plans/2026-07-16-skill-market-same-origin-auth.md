# Skill 市场同源认证修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Skill 市场 Web、浏览器 API 请求和 SSO 回调统一经过 `4211` 同源入口，并使认证 Cookie 在服务端 12 小时绝对会话期限内跨浏览器重启保留。

**Architecture:** 生产 Web 未配置覆盖值时从 `window.location.origin` 解析 API 基址，Nginx 将同源 `/v1/` 代理到保留兼容的 `127.0.0.1:4210`。服务端从绝对会话期限计算 Cookie `Max-Age`，SSO 公共回调地址在部署时切换到 `4211`。

**Tech Stack:** Bun 1.3、TypeScript、SolidJS、Vite、Effect HTTP API、Nginx 1.18、SQLite、systemd。

## Global Constraints

- 默认分支是 `dev`；测试必须从具体 package 目录运行，不能从仓库根目录运行。
- 不直接编辑生成的 `packages/client/src/generated` 或 `packages/client/src/generated-effect`。
- 保留 `4210` API 直连，不改变桌面客户端配置或主机防火墙。
- 生产 Web 运行逻辑不得写死 `10.246.13.226`，未来域名必须无需重新修改源代码。
- IP 测试继续允许显式私网 HTTP；公网 HTTP 仍必须被现有 URL 校验拒绝。
- 会话与 CSRF Cookie 的 `Max-Age` 都等于 `SKILL_MARKET_SESSION_ABSOLUTE_MINUTES * 60`；登出仍使用 `Max-Age=0`。
- Nginx `/v1/` 代理必须保留流式上传，最大请求体固定为 `55m`。
- 每个生产代码改动前必须先运行对应失败测试并确认失败原因正确。

---

### Task 1: Web 运行时同源 API 配置

**Files:**
- Create: `packages/skill-market-web/src/runtime-config.ts`
- Create: `packages/skill-market-web/src/runtime-config.test.ts`
- Modify: `packages/skill-market-web/src/app.tsx`
- Modify: `packages/skill-market-web/src/env.d.ts`
- Modify: `packages/skill-market-web/vite.config.ts`
- Modify: `packages/skill-market-web/script/vite-config.test.ts`
- Modify: `packages/skill-market-web/README.md`

**Interfaces:**
- Consumes: optional `VITE_SKILL_MARKET_API_URL`, optional `VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP`, and `window.location.origin`.
- Produces: `resolveSkillMarketRuntime(apiUrl, pageOrigin, allowInsecureHttp)` returning `{ apiBaseUrl: string; allowInsecurePrivateHttp: boolean }` for both public and control data sources.

- [ ] **Step 1: Write the failing runtime configuration test**

Create `packages/skill-market-web/src/runtime-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { resolveSkillMarketRuntime } from "./runtime-config"

describe("Skill market runtime configuration", () => {
  test("defaults production requests to the page origin", () => {
    expect(resolveSkillMarketRuntime(undefined, "http://10.246.13.226:4211", undefined)).toEqual({
      apiBaseUrl: "http://10.246.13.226:4211",
      allowInsecurePrivateHttp: true,
    })
  })

  test("keeps explicit development API overrides opt-in for private HTTP", () => {
    expect(resolveSkillMarketRuntime(" http://10.246.13.226:4210 ", "http://10.246.13.226:4211", undefined)).toEqual({
      apiBaseUrl: "http://10.246.13.226:4210",
      allowInsecurePrivateHttp: false,
    })
    expect(resolveSkillMarketRuntime("http://10.246.13.226:4210", "http://10.246.13.226:4211", "true")).toEqual({
      apiBaseUrl: "http://10.246.13.226:4210",
      allowInsecurePrivateHttp: true,
    })
  })
})
```

- [ ] **Step 2: Change the production build expectation to same-origin fallback**

In `packages/skill-market-web/script/vite-config.test.ts`, replace the missing-URL rejection test with:

```ts
test("production config allows a runtime same-origin API", () => {
  if (typeof config !== "function") throw new Error("Expected a Vite config function")
  expect(() => config({ command: "build", mode: "production", isSsrBuild: false, isPreview: false })).not.toThrow()
})
```

Change the build test environment to delete both Vite API variables instead of assigning `4210`:

```ts
const environment = { ...process.env }
delete environment.VITE_SKILL_MARKET_API_URL
delete environment.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run from `packages/skill-market-web`:

```bash
bun test src/runtime-config.test.ts script/vite-config.test.ts
```

Expected: `runtime-config.test.ts` errors because `./runtime-config` does not exist, and the production config test fails with `VITE_SKILL_MARKET_API_URL is required for production builds`.

- [ ] **Step 4: Implement the minimal runtime resolver**

Create `packages/skill-market-web/src/runtime-config.ts`:

```ts
export function resolveSkillMarketRuntime(
  apiUrl: string | undefined,
  pageOrigin: string,
  allowInsecureHttp: string | undefined,
) {
  const configured = apiUrl?.trim()
  return {
    apiBaseUrl: configured || pageOrigin,
    allowInsecurePrivateHttp: allowInsecureHttp === "true" || !configured,
  }
}
```

In `packages/skill-market-web/src/app.tsx`, create one runtime value and use it for both data sources:

```ts
import { resolveSkillMarketRuntime } from "./runtime-config"

export function App() {
  const [csrfToken, setCsrfToken] = createSignal<string>()
  const runtime = resolveSkillMarketRuntime(
    import.meta.env.VITE_SKILL_MARKET_API_URL,
    window.location.origin,
    import.meta.env.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP,
  )
  const source = createRemoteSkillMarketDataSource(runtime.apiBaseUrl, {
    allowInsecurePrivateHttp: runtime.allowInsecurePrivateHttp,
  })
  const control = createSkillMarketControlDataSource(runtime.apiBaseUrl, {
    allowInsecurePrivateHttp: runtime.allowInsecurePrivateHttp,
    csrfToken,
  })
```

In `packages/skill-market-web/src/env.d.ts`, make `VITE_SKILL_MARKET_API_URL` optional:

```ts
readonly VITE_SKILL_MARKET_API_URL?: string
```

In `packages/skill-market-web/vite.config.ts`, remove `loadEnv` and the production missing-variable throw. Keep the production base path and all existing plugins/build settings.

- [ ] **Step 5: Document the production default and explicit development override**

Update `packages/skill-market-web/README.md` so it states:

```md
生产构建默认使用页面的 `window.location.origin` 访问同源 `/v1/*`。仅在本地双端口开发或独立 API 部署时设置 `VITE_SKILL_MARKET_API_URL`；私网 HTTP 覆盖仍必须同时设置 `VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP=true`。
```

Remove the production release example that requires a fixed API URL; keep the optional override example under local or cross-origin deployment guidance.

- [ ] **Step 6: Run focused and package tests and verify GREEN**

Run from `packages/skill-market-web`:

```bash
bun test src/runtime-config.test.ts script/vite-config.test.ts
bun run test
bun typecheck
```

Expected: all tests pass; package count increases from 48 to 50 tests; typecheck exits `0`.

- [ ] **Step 7: Commit the Web runtime change**

```bash
git add packages/skill-market-web
git commit -m "fix(skill-market): use same-origin web api"
```

---

### Task 2: Nginx 同源 `/v1` 网关

**Files:**
- Modify: `packages/skill-market-server/deploy/nginx.test.ts`
- Modify: `packages/skill-market-server/deploy/nginx-ip-test.conf`
- Modify: `packages/skill-market-server/deploy/README.md`

**Interfaces:**
- Consumes: browser requests to `http://10.246.13.226:4211/v1/*`.
- Produces: URI-preserving proxy to `http://127.0.0.1:4210`, with 55 MiB upload limit and request buffering disabled.

- [ ] **Step 1: Write the failing Nginx contract assertions**

Extend the IP-test case in `packages/skill-market-server/deploy/nginx.test.ts`:

```ts
expect(config).toMatch(/location \/v1\/ \{[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:4210;/)
expect(config).toContain("client_max_body_size 55m;")
expect(config).toContain("proxy_request_buffering off;")
expect(config).toContain("proxy_set_header X-Forwarded-Proto $scheme;")
expect(config).not.toContain("http://$host:4210")
expect(config).toContain("connect-src 'self' https:")
```

- [ ] **Step 2: Run the Nginx test and verify RED**

Run from `packages/skill-market-server`:

```bash
bun test deploy/nginx.test.ts
```

Expected: FAIL because the IP config has no `/v1/` proxy and its CSP still contains `http://$host:4210`.

- [ ] **Step 3: Add the minimal same-origin proxy**

In `packages/skill-market-server/deploy/nginx-ip-test.conf`, replace both browser-facing `connect-src` values with `'self' https:` and add this location before the SPA locations:

```nginx
location /v1/ {
    client_max_body_size 55m;
    proxy_request_buffering off;
    proxy_pass http://127.0.0.1:4210;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Do not remove or change the `4210` service listener.

- [ ] **Step 4: Update IP deployment guidance**

In `packages/skill-market-server/deploy/README.md`, change the private-IP example to:

```text
SKILL_MARKET_WEB_ORIGIN=http://10.246.13.226:4211
SKILL_MARKET_API_PUBLIC_URL=http://10.246.13.226:4211
```

State that `/v1/` is proxied to loopback `4210`, while direct `4210` remains for desktop compatibility and probes.

- [ ] **Step 5: Run focused and package tests and verify GREEN**

Run from `packages/skill-market-server`:

```bash
bun test deploy/nginx.test.ts
bun test
```

Expected: Nginx tests pass and the complete server suite remains at 109 passing tests before Task 3 adds assertions.

- [ ] **Step 6: Commit the gateway change**

```bash
git add packages/skill-market-server/deploy
git commit -m "fix(skill-market): proxy web api same-origin"
```

---

### Task 3: 持久认证 Cookie

**Files:**
- Modify: `packages/skill-market-server/test/sources.test.ts`
- Modify: `packages/skill-market-server/test/auth.test.ts`
- Modify: `packages/skill-market-server/test/control-http.test.ts`
- Modify: `packages/skill-market-server/src/config.ts`
- Modify: `packages/skill-market-server/src/auth.ts`
- Modify: `packages/skill-market-server/src/http/auth.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`

**Interfaces:**
- Consumes: `SKILL_MARKET_SESSION_ABSOLUTE_MINUTES`, default `720`.
- Produces: `config.sessionCookieMaxAgeSeconds`; `MarketHttpOptions.sessionCookieMaxAgeSeconds`; login Cookie `Max-Age=43200` for the default configuration.

- [ ] **Step 1: Write failing configuration and serialization assertions**

In `packages/skill-market-server/test/sources.test.ts`, add:

```ts
expect(config.sessionCookieMaxAgeSeconds).toBe(12 * 60 * 60)
```

In the secure Cookie test in `packages/skill-market-server/test/auth.test.ts`, change the expected strings to include `Max-Age=43200`:

```ts
expect(result.setCookies).toEqual([
  `__Host-ruying_market_session=${result.sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
  `__Host-ruying_market_csrf=${result.csrfToken}; Path=/; Secure; SameSite=Lax; Max-Age=43200`,
])
```

In `loginSession` inside `packages/skill-market-server/test/control-http.test.ts`, inspect headers before stripping attributes:

```ts
const setCookies = response.headers.getSetCookie()
expect(setCookies).toHaveLength(2)
expect(setCookies.every((value) => value.includes("Max-Age=43200"))).toBe(true)
const cookies = setCookies.map((value) => value.split(";", 1)[0])
```

Add `sessionCookieMaxAgeSeconds: 12 * 60 * 60` to the `createMarketWebHandler` fixture options.

- [ ] **Step 2: Run focused tests and verify RED**

Run from `packages/skill-market-server`:

```bash
bun test test/sources.test.ts test/auth.test.ts test/control-http.test.ts
```

Expected: FAIL because the config property is missing and successful login Cookie headers do not contain `Max-Age=43200`.

- [ ] **Step 3: Derive the Cookie lifetime from server configuration**

In `packages/skill-market-server/src/config.ts`, return:

```ts
sessionCookieMaxAgeSeconds: sessionAbsoluteMinutes * 60,
```

Keep `sessionAbsoluteMilliseconds: sessionAbsoluteMinutes * 60 * 1_000` unchanged so database expiry semantics do not change.

- [ ] **Step 4: Persist the auth service Cookie strings**

In `packages/skill-market-server/src/auth.ts`, compute once inside `createAuth`:

```ts
const sessionCookieMaxAgeSeconds = Math.floor(options.sessionAbsoluteMilliseconds / 1_000)
```

Pass that value to successful login Cookie serialization and `0` to logout serialization. Replace the helper with:

```ts
function cookie(name: string, value: string, httpOnly: boolean, secure: boolean, maxAge: number) {
  return [
    `${name}=${value}`,
    "Path=/",
    ...(httpOnly ? ["HttpOnly"] : []),
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ")
}
```

- [ ] **Step 5: Persist the actual Effect HTTP response Cookie**

Add this required property to `AuthHttpOptions` in `packages/skill-market-server/src/http/auth.ts` and `MarketHttpOptions` in `packages/skill-market-server/src/handlers.ts`:

```ts
readonly sessionCookieMaxAgeSeconds: number
```

Import `Duration` beside `Effect` in `src/http/auth.ts`:

```ts
import { Duration, Effect } from "effect"
```

For both successful login Cookie option objects, convert the configured seconds to an Effect duration:

```ts
maxAge: Duration.seconds(options.sessionCookieMaxAgeSeconds),
```

Keep logout option objects at `maxAge: 0`.

In `packages/skill-market-server/src/server.ts`, pass the derived value into `createMarketRoutes`:

```ts
sessionCookieMaxAgeSeconds: config.sessionCookieMaxAgeSeconds,
```

- [ ] **Step 6: Run focused and complete verification**

Run from `packages/skill-market-server`:

```bash
bun test test/sources.test.ts test/auth.test.ts test/control-http.test.ts
bun test
bun typecheck
```

Expected: all 109 server tests pass with the stronger Cookie assertions, and typecheck exits `0`.

- [ ] **Step 7: Commit the Cookie change**

```bash
git add packages/skill-market-server/src packages/skill-market-server/test
git commit -m "fix(skill-market): persist login cookies"
```

---

### Task 4: Cross-component release verification

**Files:**
- Verify only; no generated source files are modified.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: tested Web distribution and immutable API release directory ready for deployment.

- [ ] **Step 1: Check source cleanliness and patch quality**

Run from the worktree root:

```bash
git status --short
git diff --check dev...HEAD
git log --oneline dev..HEAD
```

Expected: no uncommitted tracked changes, no whitespace errors, and exactly the design/plan plus three implementation commits.

- [ ] **Step 2: Run the complete package gates**

Run:

```bash
cd packages/skill-market-web
bun run test
bun typecheck
cd ../skill-market-server
bun test
bun typecheck
```

Expected: Web has 50 passing tests, server has 109 passing tests, and both typechecks exit `0`.

- [ ] **Step 3: Build production artifacts without a fixed Web API host**

Run:

```bash
rm -rf /tmp/ruying-skill-market-web-same-origin /tmp/ruying-skill-market-server-same-origin
cd packages/skill-market-web
env -u VITE_SKILL_MARKET_API_URL -u VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP bun run build -- --outDir /tmp/ruying-skill-market-web-same-origin
cd ../skill-market-server
bun run build:release /tmp/ruying-skill-market-server-same-origin
```

Expected: both builds exit `0`; the Web bundle does not contain `10.246.13.226:4210` and the server release contains the bundled `packages/skill-market-server/src/server.ts` entry at the script-preserved path.

- [ ] **Step 4: Inspect artifact contracts**

Run:

```bash
rg "10\.246\.13\.226:4210" /tmp/ruying-skill-market-web-same-origin && exit 1 || true
test -f /tmp/ruying-skill-market-web-same-origin/index.html
test -f /tmp/ruying-skill-market-server-same-origin/packages/skill-market-server/src/server.ts
```

Expected: no fixed `4210` string is found and both required entry files exist.

---

### Task 5: Guarded production deployment and live SSO verification

**Files:**
- Deploy generated artifacts and tracked Nginx configuration; do not edit repository files during this task.

**Interfaces:**
- Consumes: Task 4 artifacts, server `10.246.13.226:9922`, existing root-only environment file, current immutable releases.
- Produces: live same-origin `/v1` gateway, same-origin SSO callback, persistent Cookie headers, and a verified投稿 form.

- [ ] **Step 1: Capture rollback state without printing secrets**

Run locally:

```bash
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 'readlink -f /srv/ruying-skill-market/current; readlink -f /srv/ruying-skill-market/web/current; nginx -t; systemctl is-active ruying-skill-market nginx'
```

Expected: both release paths are printed, Nginx syntax is valid, and both services are active.

- [ ] **Step 2: Back up protected configuration on the server**

Run:

```bash
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 'stamp=$(date -u +%Y%m%dT%H%M%SZ); install -d -o root -g root -m 0700 /var/backups/ruying-skill-market/config-$stamp; cp -a /etc/nginx/sites-enabled/ruying-skill-market /var/backups/ruying-skill-market/config-$stamp/nginx.conf; cp -a /etc/ruying-skill-market/market.env /var/backups/ruying-skill-market/config-$stamp/market.env; echo /var/backups/ruying-skill-market/config-$stamp'
```

Expected: one new root-only backup directory is printed; environment contents are never printed.

- [ ] **Step 3: Install and validate the Nginx same-origin proxy first**

Transfer the rendered tracked IP config to a root-only candidate path, preserving the existing OSS proxy target values from the live config. Install only after `nginx -t -c` succeeds, then reload Nginx. Verify:

```bash
curl -sS -i --max-time 10 'http://10.246.13.226:4211/v1/auth/session'
```

Expected: `200`, `Content-Type: application/json`, and body `null`; the response must not be SPA HTML.

- [ ] **Step 4: Install immutable Web and API releases**

Use the existing release roots and compute exact immutable target names from the verified artifacts:

```bash
api_release="/srv/ruying-skill-market/releases/$(git rev-parse HEAD)"
web_release="/srv/ruying-skill-market/web/releases/$(bun -e 'const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: "/tmp/ruying-skill-market-web-same-origin", onlyFiles: true })); const records = await Promise.all(files.toSorted().map(async (path) => { const body = await Bun.file(`/tmp/ruying-skill-market-web-same-origin/${path}`).bytes(); return { path, sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"), size: body.byteLength } })); console.log(new Bun.CryptoHasher("sha256").update(JSON.stringify(records)).digest("hex").slice(0, 16))')"
```

Transfer Task 4 artifacts to temporary server directories, verify sizes/hashes, atomically rename them into the immutable release locations, then atomically advance `/srv/ruying-skill-market/current` and `/srv/ruying-skill-market/web/current`. Retain the immediately previous releases.

- [ ] **Step 5: Change only the public callback origin**

Edit `/etc/ruying-skill-market/market.env` through a root-only temporary file so this exact assignment is present once:

```text
SKILL_MARKET_API_PUBLIC_URL=http://10.246.13.226:4211
```

Preserve owner `root`, group `ruying-market`, and mode `0640`. Do not print the environment file. Restart `ruying-skill-market` and confirm it remains active.

- [ ] **Step 6: Run service and authentication smoke checks**

Run:

```bash
curl -sS --max-time 10 'http://10.246.13.226:4210/health'
curl -sS --max-time 10 'http://10.246.13.226:4211/v1/auth/session'
curl -sS -I --max-time 10 'http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/submissions/new'
curl -sS -D - -o /dev/null --max-time 10 'http://10.246.13.226:4211/v1/auth/login?returnTo=%2Fsubmissions%2Fnew'
```

Expected: both health paths report ready, the投稿 route returns `200`, and the SSO `Location` contains an encoded callback beginning with `http://10.246.13.226:4211/v1/auth/callback/`.

- [ ] **Step 7: Complete real browser verification**

Open:

```text
http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/submissions/new
```

Complete GWM SSO, then verify:

1. The browser returns to the same `/submissions/new` URL.
2. The投稿 form renders instead of “登录后继续”.
3. Refresh preserves the session.
4. A fresh browser launch preserves the session while the 12-hour absolute session is valid.
5. The latest database login attempt stores `/submissions/new`, and the session activity advances without exposing Cookie values.

- [ ] **Step 8: Roll back on any failed live check**

Restore the backup environment and Nginx config, atomically return both symlinks to the paths captured in Step 1, run `nginx -t`, reload Nginx, restart the API, and rerun the pre-deployment smoke checks. Do not delete failed immutable releases until the incident is understood.
