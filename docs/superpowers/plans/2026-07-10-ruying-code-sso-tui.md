# Ruying Code SSO and TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有 CLI/TUI 使用同一套 GWM SSO，并在登录前阻止会话、登录后只暴露如影网关。

**Architecture:** 继续使用内置 `RuyingAuthPlugin` 和现有 ProviderAuth HttpApi，重构回调与配置持久化为可测试边界。TUI 通过 Provider 状态渲染门禁；非交互 CLI 在执行模型工作前检查同一登录标记。

**Tech Stack:** TypeScript, Effect, SolidJS, OpenTUI, Bun HTTP server, bun:test

## Global Constraints

- SSO 登录地址、`check_token`、`aicoding-admin` 和网关模型流程必须与 `chelper login` 语义一致。
- 默认回调端口为 `9527`，超时为五分钟。
- 未登录不能进入 TUI 会话；登录后只能使用 Provider `ruying`。
- API Key 只进入凭据存储；公开状态只包含工号、姓名和邮箱。
- 不使用真实生产接口运行测试；使用本地 HTTP 测试服务。

---

### Task 1: Stabilize the Ruying auth result and callback lifecycle

**Files:**
- Modify: `packages/opencode/src/plugin/ruying.ts`
- Modify: `packages/opencode/test/plugin/ruying.test.ts`

**Interfaces:**
- Produces: `RuyingUser`, `ProvisionResult`, `buildSsoUrl`, and an auth success result with `metadata.employeeId`, `metadata.displayName`, `metadata.email`.

- [ ] **Step 1: Add failing tests for fallback port, timeout cleanup, and metadata**

```ts
test("returns public identity metadata with the api key", async () => {
  using admin = makeServer(() => Response.json({ status: "ready", key: "sk-test", tokenName: "GW001-张三" }))
  using sso = makeServer(() => Response.json({ key: "S_0000", result: { user_code: "GW001", user_name: "张三" } }))
  const hooks = await RuyingAuthPlugin({} as never, {
    adminApiBase: baseUrl(admin),
    checkTokenUrl: baseUrl(sso),
    callbackPort: 0,
    configFile: tmpConfigFile(),
  })
  const authorized = await oauthMethod(hooks).authorize!()
  const redirect = new URL(authorized.url).searchParams.get("redirect_url")!
  const callback = authorized.callback()
  await fetch(`${redirect}?access_token=token`)
  expect(await callback).toMatchObject({
    type: "success",
    key: "sk-test",
    metadata: { employeeId: "GW001", displayName: "张三" },
  })
})

test("releases the callback server after timeout", async () => {
  const hooks = await RuyingAuthPlugin({} as never, { callbackPort: 0, callbackTimeoutMs: 10 })
  const authorized = await oauthMethod(hooks).authorize!()
  const port = Number(new URL(new URL(authorized.url).searchParams.get("redirect_url")!).port)
  expect(await authorized.callback()).toEqual({ type: "failed" })
  using probe = Bun.serve({ port, fetch: () => new Response("ok") })
  expect(probe.port).toBe(port)
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/opencode`: `bun test test/plugin/ruying.test.ts`  
Expected: metadata assertion and timeout cleanup test FAIL.

- [ ] **Step 3: Return metadata and centralize final cleanup**

```ts
return {
  type: "success" as const,
  key: outcome.key,
  metadata: {
    employeeId: outcome.user.employeeId,
    displayName: outcome.user.displayName,
    email: outcome.user.email,
  },
}
```

Ensure every callback branch executes `stopOAuthServer()` in `finally`; when port `9527` is implicit and occupied, retry with port `0`, but preserve an explicit configured-port error.

- [ ] **Step 4: Run test and typecheck**

Run from `packages/opencode`: `bun test test/plugin/ruying.test.ts && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/plugin/ruying.ts packages/opencode/test/plugin/ruying.test.ts
git commit -m "fix(opencode): harden ruying sso lifecycle"
```

### Task 2: Persist Ruying provider state safely and isolate providers

**Files:**
- Modify: `packages/opencode/src/plugin/ruying.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts`
- Modify: `packages/opencode/test/plugin/ruying.test.ts`
- Modify: `packages/opencode/test/server/httpapi-provider.test.ts`

**Interfaces:**
- Produces: `writeGlobalProviderConfig(file, gatewayApiBase, modelIds, user)` with JSONC support and `visibleProviderIDs(all, enabled, disabled)` for deterministic filtering.

- [ ] **Step 1: Add failing JSONC and isolation tests**

```ts
test("updates jsonc without discarding comments", async () => {
  await Bun.write(file, "{\n  // keep\n  \"theme\": \"opencode\"\n}\n")
  writeGlobalProviderConfig(file, "https://gateway/v1", ["model-a"], user)
  expect(await Bun.file(file).text()).toContain("// keep")
})

test("provider list exposes only ruying after login", () => {
  expect(visibleProviderIDs(["ruying", "openai"], new Set(["ruying"]), new Set())).toEqual(["ruying"])
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/opencode`: `bun test test/plugin/ruying.test.ts test/server/httpapi-provider.test.ts`  
Expected: JSONC preservation FAIL.

- [ ] **Step 3: Replace JSON.parse/write with jsonc-parser edits**

```ts
const edits = modify(source, ["enabled_providers"], [Brand.profile.providerID], formatting)
const withProviders = applyEdits(source, edits)
const providerEdit = modify(withProviders, ["provider", Brand.profile.providerID], patch, formatting)
await Bun.write(file, applyEdits(withProviders, providerEdit))
```

Keep plugin-only `ruying` visible before login, but never add other plugin-only providers in the OEM profile.

```ts
export function visibleProviderIDs(all: string[], enabled?: Set<string>, disabled = new Set<string>()) {
  return all.filter((id) => (enabled ? enabled.has(id) : id === Brand.profile.providerID) && !disabled.has(id))
}
```

- [ ] **Step 4: Run tests and typecheck**

Run from `packages/opencode`: `bun test test/plugin/ruying.test.ts test/server/httpapi-provider.test.ts && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/plugin/ruying.ts packages/opencode/src/server/routes/instance/httpapi/handlers/provider.ts packages/opencode/test/plugin/ruying.test.ts packages/opencode/test/server/httpapi-provider.test.ts
git commit -m "feat(opencode): isolate the ruying provider"
```

### Task 3: Add branded login and logout commands

**Files:**
- Create: `packages/opencode/src/cli/cmd/ruying-auth.ts`
- Create: `packages/opencode/test/cli/cmd/ruying-auth.test.ts`
- Modify: `packages/opencode/src/index.ts`
- Modify: `packages/opencode/src/cli/cmd/providers.ts`

**Interfaces:**
- Produces: top-level `LoginCommand`, `LogoutCommand`, `runLogin`, and `runLogout`; `ProvidersLoginCommand` exposes a single-provider execution boundary used by `LoginCommand`.

- [ ] **Step 1: Write command tests**

```ts
test("login always selects ruying", async () => {
  const calls: string[] = []
  await runLogin({ loginProvider: async (id) => calls.push(id) })
  expect(calls).toEqual(["ruying"])
})

test("logout removes only ruying credentials", async () => {
  const removed: string[] = []
  await runLogout({ remove: async (id) => removed.push(id) })
  expect(removed).toEqual(["ruying"])
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/opencode`: `bun test test/cli/cmd/ruying-auth.test.ts`  
Expected: FAIL because commands do not exist.

- [ ] **Step 3: Implement thin branded commands**

```ts
export function runLogin(input: { loginProvider: (providerID: string) => Promise<void> }) {
  return input.loginProvider(Brand.profile.providerID)
}

export function runLogout(input: { remove: (providerID: string) => Promise<void> }) {
  return input.remove(Brand.profile.providerID)
}

export const LoginCommand = effectCmd({
  command: "login",
  describe: "使用 GWM SSO 登录如影 Code",
  handler: Effect.fn("Cli.ruying.login")(function* () {
    yield* loginProvider(Brand.profile.providerID)
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout",
  describe: "退出如影 Code",
  instance: false,
  handler: Effect.fn("Cli.ruying.logout")(function* () {
    yield* (yield* Auth.Service).remove(Brand.profile.providerID)
  }),
})
```

- [ ] **Step 4: Run test and typecheck**

Run from `packages/opencode`: `bun test test/cli/cmd/ruying-auth.test.ts && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/cli/cmd/ruying-auth.ts packages/opencode/test/cli/cmd/ruying-auth.test.ts packages/opencode/src/index.ts packages/opencode/src/cli/cmd/providers.ts
git commit -m "feat(opencode): add ruying login commands"
```

### Task 4: Reject model execution before SSO login

**Files:**
- Create: `packages/opencode/src/auth/ruying-gate.ts`
- Create: `packages/opencode/test/auth/ruying-gate.test.ts`
- Modify: `packages/opencode/src/cli/cmd/run.ts`
- Modify: `packages/opencode/src/acp/service.ts`

**Interfaces:**
- Produces: `requireRuyingLogin(auth): Promise<void>` and its Effect wrapper.

- [ ] **Step 1: Write the failing gate test**

```ts
test("requires both a ruying key and sso identity metadata", async () => {
  await expect(requireRuyingLogin(undefined)).rejects.toThrow("ruying-code login")
  await expect(requireRuyingLogin({ type: "api", key: "sk", metadata: {} })).rejects.toThrow("ruying-code login")
  await expect(
    requireRuyingLogin({ type: "api", key: "sk", metadata: { employeeId: "GW001", displayName: "张三" } }),
  ).resolves.toBeUndefined()
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/opencode`: `bun test test/auth/ruying-gate.test.ts`  
Expected: FAIL because the gate is missing.

- [ ] **Step 3: Implement and call the gate**

```ts
export async function requireRuyingLogin(auth: Auth.Info | undefined) {
  const user = auth?.type === "api" ? auth.metadata : undefined
  if (auth?.type === "api" && user?.employeeId) return
  throw new Error("请先运行 ruying-code login 完成 GWM SSO 登录")
}
```

Invoke the Effect wrapper before `run` creates or resumes a model session and before ACP resolves its default model. Do not gate `serve`, because TUI and Desktop need the server's auth endpoints to perform login.

- [ ] **Step 4: Run tests and typecheck**

Run from `packages/opencode`: `bun test test/auth/ruying-gate.test.ts && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/auth/ruying-gate.ts packages/opencode/test/auth/ruying-gate.test.ts packages/opencode/src/cli/cmd/run.ts packages/opencode/src/acp/service.ts
git commit -m "feat(opencode): require sso before model execution"
```

### Task 5: Add the TUI login gate and hide provider connection UI

**Files:**
- Create: `packages/tui/src/component/ruying-login.tsx`
- Create: `packages/tui/test/component/ruying-login.test.tsx`
- Modify: `packages/tui/src/app.tsx`
- Modify: `packages/tui/src/component/dialog-model.tsx`
- Modify: `packages/tui/src/feature-plugins/home/tips-view.tsx`
- Modify: `packages/tui/src/logo.ts`
- Modify: `packages/tui/src/component/error-component.tsx`
- Modify: `packages/tui/test/app-lifecycle.test.tsx`

**Interfaces:**
- Produces: `RuyingLoginGate(props: ParentProps)`; consumes ProviderAuth SDK methods and `provider.ruying.options.ruyingUser`.

- [ ] **Step 1: Write gate tests**

```tsx
test("blocks children until ruying identity exists", () => {
  expect(isRuyingLoggedIn(undefined)).toBe(false)
  expect(isRuyingLoggedIn({ apiKey: "sk-existing" })).toBe(false)
})

test("accepts a logged-in ruying user", () => {
  expect(isRuyingLoggedIn({ ruyingUser: { employeeId: "GW001", displayName: "张三" } })).toBe(true)
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/tui`: `bun test test/component/ruying-login.test.tsx`  
Expected: FAIL because the gate is missing.

- [ ] **Step 3: Implement the gate and branded wordmark**

```tsx
export function isRuyingLoggedIn(options: unknown) {
  if (!options || typeof options !== "object") return false
  const user = (options as { ruyingUser?: unknown }).ruyingUser
  return !!user && typeof user === "object"
}

export function RuyingLoginGate(props: ParentProps) {
  const sync = useSync()
  const provider = createMemo(() => sync.data.provider_next.all.find((x) => x.id === "ruying"))
  return <Show when={isRuyingLoggedIn(provider()?.options)} fallback={<RuyingLogin />}>{props.children}</Show>
}
```

Wrap the routed app inside the gate after `SyncProvider` mounts. Remove `provider.connect` from the command list, hide the DialogModel connection footer, replace connection tips with `ruying-code login`, set terminal title to `Brand.profile.displayName`, and replace the ASCII wordmark with `如影 CODE` while preserving theme colors.

- [ ] **Step 4: Run focused and package tests**

Run from `packages/tui`: `bun test test/component/ruying-login.test.tsx test/app-lifecycle.test.tsx && bun typecheck`  
Expected: PASS and lifecycle cleanup remains unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src packages/tui/test
git commit -m "feat(tui): require ruying sso login"
```
