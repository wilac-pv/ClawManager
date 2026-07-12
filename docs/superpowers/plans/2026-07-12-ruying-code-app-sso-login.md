# Ruying Code App SSO Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both production App layouts start and complete GWM SSO through the system browser without requiring `ruying-code login` in a terminal.

**Architecture:** Move the existing `RuyingGate` into the server context shared by the legacy and new layouts. Extend the existing testable login state machine with platform URL opening, cancellation, in-place server bootstrap, and an authoritative status check while continuing to use the current ProviderAuth callback and credential persistence flow.

**Tech Stack:** TypeScript, SolidJS, Bun test, TanStack Solid Query, Electron platform IPC, existing ProviderAuth HttpApi

## Global Constraints

- Use the existing ProviderAuth GWM SSO flow, loopback callback, provisioning service, credential storage, and Ruying session status endpoint.
- Open SSO in the system default browser on Desktop and a new tab on Web through `Platform.openLink`.
- Apply the same login gate to the legacy and new App layouts.
- Login success must enter the App in place without `window.location.reload()` or an application restart.
- Preserve a clickable fallback URL and a cancel action while login is pending.
- Ignore stale login and cancellation responses; they must not overwrite the current attempt.
- Keep API keys, SSO tokens, and callback query parameters out of UI errors and logs.
- Keep the non-interactive CLI `ruying-code login` message unchanged.
- Do not modify public Protocol or Server HttpApi unless a failing test proves the current surface insufficient.
- Run tests and typechecks from package directories, never from the repository root.

---

## File Structure

- `packages/app/src/components/ruying-login.tsx`: owns the Ruying gate state, login attempt state machine, login screen, and SDK/platform controller adapters.
- `packages/app/src/components/ruying-login.test.tsx`: tests state transitions and stale-attempt behavior without App contexts.
- `packages/app/src/components/ruying-wiring.test.tsx`: tests Solid context wiring and mounted login controls.
- `packages/app/src/context/server-sync.tsx`: exposes a narrow root bootstrap operation already backed by the existing root bootstrap query.
- `packages/app/src/app.tsx`: places one login gate inside the server providers shared by both visual layouts.
- `packages/app/src/ruying-layout-gate.test.ts`: protects the layout composition against moving the gate back into only one visual layout.

No new authentication service or Desktop IPC endpoint is needed. `Platform.openLink` already maps Desktop calls to Electron `shell.openExternal` and Web calls to `window.open`.

---

### Task 1: Extend the login attempt state machine

**Files:**
- Modify: `packages/app/src/components/ruying-login.tsx:11-121`
- Modify: `packages/app/src/components/ruying-login.test.tsx:136-190`

**Interfaces:**
- Consumes: the existing ProviderAuth result shapes `{ data?: { url?: string }; error?: unknown }` and `{ data?: boolean; error?: unknown }`.
- Produces: `createRuyingLoginState(input)` returning `{ state, login, cancel, open }`, where `state.status` is `"idle" | "pending" | "canceling" | "error"`.

- [ ] **Step 1: Add a failing test that opens the authorization URL before waiting for the callback**

Append this test to `packages/app/src/components/ruying-login.test.tsx`:

```ts
test("opens the system browser before waiting for the oauth callback", async () => {
  const callback = deferred<{ data?: boolean; error?: unknown }>()
  const events: string[] = []
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: (url) => events.push(`open:${url}`),
    callback: () => {
      events.push("callback")
      return callback.promise
    },
    cancel: async () => ({ data: true }),
    dispose: async () => events.push("dispose"),
    bootstrap: async () => events.push("bootstrap"),
    status: async () => ({ data: { loggedIn: true } }),
  })

  const pending = login.login()
  await Promise.resolve()

  expect(events).toEqual(["open:https://sso.example/login", "callback"])
  expect(login.state.status).toBe("pending")

  callback.resolve({ data: true })
  await pending
})
```

- [ ] **Step 2: Run the test and verify the RED state**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/components/ruying-login.test.tsx -t "opens the system browser"
```

Expected: FAIL because the existing state machine never calls `openLink`.

- [ ] **Step 3: Add failing cancellation and authoritative-refresh tests**

Append these tests to the same file:

```ts
test("cancel invalidates the pending callback and returns to idle", async () => {
  const callback = deferred<{ data?: boolean; error?: unknown }>()
  const events: string[] = []
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => undefined,
    callback: () => callback.promise,
    cancel: async () => {
      events.push("cancel")
      return { data: true }
    },
    dispose: async () => events.push("dispose"),
    bootstrap: async () => events.push("bootstrap"),
    status: async () => ({ data: { loggedIn: true } }),
  })

  const pending = login.login()
  await Promise.resolve()
  await login.cancel()
  callback.resolve({ data: true })
  await pending

  expect(events).toEqual(["cancel"])
  expect(login.state.status).toBe("idle")
})

test("successful callback refreshes in place and requires authoritative login status", async () => {
  const events: string[] = []
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => events.push("open"),
    callback: async () => {
      events.push("callback")
      return { data: true }
    },
    cancel: async () => ({ data: true }),
    dispose: async () => events.push("dispose"),
    bootstrap: async () => events.push("bootstrap"),
    status: async () => {
      events.push("status")
      return { data: { loggedIn: false } }
    },
  })

  await login.login()

  expect(events).toEqual(["open", "callback", "dispose", "bootstrap", "status"])
  expect(login.state.status).toBe("error")
  expect(login.state.message).toContain("登录状态未生效")
})
```

- [ ] **Step 4: Run the new tests and verify the RED state**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/components/ruying-login.test.tsx -t "cancel invalidates|successful callback refreshes"
```

Expected: FAIL because `cancel`, `bootstrap`, and the post-login status check do not exist.

- [ ] **Step 5: Replace the login status type and login state machine with the minimal implementation**

In `packages/app/src/components/ruying-login.tsx`, replace `LoginStatus` and `createRuyingLoginState` with:

```ts
type LoginStatus = "idle" | "pending" | "canceling" | "error"

export function createRuyingLoginState(input: {
  authorize: () => Promise<{ data?: { url?: string }; error?: unknown }>
  openLink: (url: string) => void
  callback: () => Promise<{ data?: boolean; error?: unknown }>
  cancel: () => Promise<{ data?: boolean; error?: unknown }>
  dispose: () => Promise<unknown>
  bootstrap: () => Promise<unknown>
  status: () => Promise<{ data?: { loggedIn: boolean }; error?: unknown }>
}) {
  const [state, setState] = createStore({
    status: "idle" as LoginStatus,
    message: "",
    authUrl: "",
  })
  let attempt = 0

  function open() {
    if (!state.authUrl) return
    try {
      input.openLink(state.authUrl)
    } catch {
      setState("message", "未能自动打开浏览器，请点击或复制下方链接继续登录。")
    }
  }

  async function login() {
    const current = ++attempt
    setState({ status: "pending", message: "", authUrl: "" })
    try {
      const authorized = await input.authorize()
      if (current !== attempt) return
      if (authorized.error || !authorized.data?.url) {
        setState({ status: "error", message: "无法启动 GWM SSO 登录，请重试。", authUrl: "" })
        return
      }
      setState("authUrl", authorized.data.url)
      open()
      const result = await input.callback()
      if (current !== attempt) return
      if (result.error || result.data !== true) {
        setState({
          status: "error",
          message: "登录失败，请重试。若提示待管理员开通，请联系管理员开通后再登录。",
          authUrl: authorized.data.url,
        })
        return
      }
      await input.dispose()
      if (current !== attempt) return
      await input.bootstrap()
      if (current !== attempt) return
      const refreshed = await input.status()
      if (current !== attempt) return
      if (refreshed.error || !refreshed.data?.loggedIn) {
        setState({ status: "error", message: "登录状态未生效，请重试。", authUrl: authorized.data.url })
        return
      }
      setState({ status: "idle", message: "", authUrl: "" })
    } catch {
      if (current !== attempt) return
      setState({
        status: "error",
        message: state.authUrl ? "登录失败，请重试。" : "无法启动 GWM SSO 登录，请重试。",
        authUrl: state.authUrl,
      })
    }
  }

  async function cancel() {
    if (state.status !== "pending") return
    const current = ++attempt
    setState("status", "canceling")
    try {
      const result = await input.cancel()
      if (current !== attempt) return
      if (result.error || result.data !== true) {
        setState({ status: "error", message: "取消登录失败，请重试。", authUrl: state.authUrl })
        return
      }
      setState({ status: "idle", message: "", authUrl: "" })
    } catch {
      if (current !== attempt) return
      setState({
        status: "error",
        message: "取消登录失败，请重试。",
        authUrl: state.authUrl,
      })
    }
  }

  return { state, login, cancel, open }
}
```

Update the three existing login-state tests to provide the new `openLink`, `cancel`, `bootstrap`, and `status` dependencies. Remove their `reload` dependencies, assert `dispose → bootstrap → status` instead of `dispose → reload`, and change the rejected-authorize assertion to expect the safe generic text `无法启动 GWM SSO 登录` rather than the raw exception message.

- [ ] **Step 6: Add the stale-login and browser-fallback regression tests**

Append:

```ts
test("a failed automatic browser open keeps the fallback url and callback active", async () => {
  const callback = deferred<{ data?: boolean; error?: unknown }>()
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => {
      throw new Error("no handler")
    },
    callback: () => callback.promise,
    cancel: async () => ({ data: true }),
    dispose: async () => undefined,
    bootstrap: async () => undefined,
    status: async () => ({ data: { loggedIn: true } }),
  })

  const pending = login.login()
  await Promise.resolve()
  expect(login.state.status).toBe("pending")
  expect(login.state.authUrl).toBe("https://sso.example/login")
  expect(login.state.message).toContain("复制")

  callback.resolve({ error: new Error("stopped") })
  await pending
})

test("a newer login attempt ignores the older callback", async () => {
  const first = deferred<{ data?: boolean; error?: unknown }>()
  let callbacks = 0
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: `https://sso.example/${callbacks + 1}` } }),
    openLink: () => undefined,
    callback: () => (++callbacks === 1 ? first.promise : Promise.resolve({ data: true })),
    cancel: async () => ({ data: true }),
    dispose: async () => undefined,
    bootstrap: async () => undefined,
    status: async () => ({ data: { loggedIn: true } }),
  })

  const stale = login.login()
  await Promise.resolve()
  const current = login.login()
  await current
  first.resolve({ error: new Error("stale") })
  await stale

  expect(login.state.status).toBe("idle")
  expect(login.state.message).toBe("")
})
```

- [ ] **Step 7: Run the complete state-machine test file**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/components/ruying-login.test.tsx
```

Expected: all tests PASS with zero failures.

- [ ] **Step 8: Commit the state machine**

```bash
git add packages/app/src/components/ruying-login.tsx packages/app/src/components/ruying-login.test.tsx
git commit -m "feat(app): add browser sso login state"
```

---

### Task 2: Wire platform opening, cancellation, and in-place bootstrap

**Files:**
- Modify: `packages/app/src/context/server-sync.tsx:455-490`
- Modify: `packages/app/src/components/ruying-login.tsx:123-230`
- Modify: `packages/app/src/components/ruying-wiring.test.tsx:1-220`

**Interfaces:**
- Consumes: `createRuyingLoginState` from Task 1 and existing `Platform.openLink`, `provider.oauth.cancel`, `global.dispose`, and `provider.ruying.status` SDK methods.
- Produces: `serverSync().bootstrap(): Promise<void>` and `createRuyingLoginController()` wired to a captured server runtime.

- [ ] **Step 1: Change the wiring test runtime and add a failing end-to-end controller-order test**

In `packages/app/src/components/ruying-wiring.test.tsx`, change the mocked runtime types to include cancellation and make server sync include bootstrap:

```ts
type Runtime = {
  client: {
    provider: {
      ruying: { status: () => Promise<{ data: { loggedIn: boolean } }> }
      oauth: {
        authorize: (...args: unknown[]) => Promise<unknown>
        callback: (...args: unknown[]) => Promise<unknown>
        cancel: (...args: unknown[]) => Promise<unknown>
      }
    }
    global: { dispose: () => Promise<unknown> }
  }
  event: { on: (_scope: string, listener: (event: { type: string }) => void) => () => void }
}

const [sync, setSync] = createSignal({ ready: false, bootstrap: async () => undefined })
const openLink = mock(() => undefined)
mock.module("@/context/platform", () => ({ usePlatform: () => ({ openLink }) }))
```

Add this helper above the wiring tests:

```ts
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
```

Replace the existing controller wiring test with:

```ts
test("login controller opens the browser and refreshes the captured server in place", async () => {
  const calls: string[] = []
  const current = runtime(false, [])
  current.client.provider.oauth.authorize = async () => {
    calls.push("authorize")
    return { data: { url: "https://sso.example/login" } }
  }
  current.client.provider.oauth.callback = async () => {
    calls.push("callback")
    return { data: true }
  }
  current.client.global.dispose = async () => calls.push("dispose")
  current.client.provider.ruying.status = async () => {
    calls.push("status")
    return { data: { loggedIn: true } }
  }
  openLink.mockImplementation((url: string) => calls.push(`open:${url}`))
  setSync({
    ready: true,
    bootstrap: async () => {
      calls.push("bootstrap")
    },
  })
  setSdk(current)

  let login!: ReturnType<typeof createRuyingLoginController>
  const dispose = createRoot((close) => {
    login = createRuyingLoginController()
    return close
  })
  await login.login()

  expect(calls).toEqual([
    "authorize",
    "open:https://sso.example/login",
    "callback",
    "dispose",
    "bootstrap",
    "status",
  ])
  dispose()
})
```

Update `runtime()` so `oauth.cancel` resolves `{ data: true }`.

In the same step, add this test to prove an attempt cannot jump to a newly selected server:

```ts
test("pending login remains bound to the server that authorized it", async () => {
  const callback = deferred<{ data?: boolean; error?: unknown }>()
  const calls: string[] = []
  const first = runtime(false, [])
  first.client.provider.oauth.authorize = async () => ({ data: { url: "https://sso.example/login" } })
  first.client.provider.oauth.callback = () => callback.promise
  first.client.global.dispose = async () => {
    calls.push("first:dispose")
  }
  first.client.provider.ruying.status = async () => {
    calls.push("first:status")
    return { data: { loggedIn: true } }
  }
  const second = runtime(false, [])
  second.client.global.dispose = async () => {
    calls.push("second:dispose")
  }
  second.client.provider.ruying.status = async () => {
    calls.push("second:status")
    return { data: { loggedIn: true } }
  }
  setSync({
    ready: true,
    bootstrap: async () => {
      calls.push("first:bootstrap")
    },
  })
  setSdk(first)

  let login!: ReturnType<typeof createRuyingLoginController>
  const dispose = createRoot((close) => {
    login = createRuyingLoginController()
    return close
  })
  const pending = login.login()
  await Promise.resolve()
  setSdk(second)
  setSync({
    ready: true,
    bootstrap: async () => {
      calls.push("second:bootstrap")
    },
  })
  callback.resolve({ data: true })
  await pending

  expect(calls).toEqual(["first:dispose", "first:bootstrap", "first:status"])
  dispose()
})
```

- [ ] **Step 2: Run the wiring test and verify the RED state**

Run from `packages/app`:

```bash
bun test --conditions=browser \
  --preload ./happydom.ts \
  --preload ./solid-test-preload.ts \
  ./src/components/ruying-wiring.test.tsx \
  -t "opens the browser and refreshes"
```

Expected: FAIL because the controller still uses `reload` and server sync exposes no `bootstrap` method.

- [ ] **Step 3: Expose the existing root bootstrap query as a narrow async method**

In the object returned by `createServerSyncContextInner` in `packages/app/src/context/server-sync.tsx`, add this property immediately after `queryOptions`:

```ts
bootstrap: async () => {
  const result = await bootstrap.refetch()
  if (result.error) throw result.error
},
```

This reuses the existing root bootstrap query and does not introduce a second synchronization implementation.

- [ ] **Step 4: Wire the login controller to the captured SDK, platform, and server sync**

Add `usePlatform` to `packages/app/src/components/ruying-login.tsx` imports. Replace `createRuyingLoginController` with:

```ts
export function createRuyingLoginController() {
  const serverSDK = useServerSDK()()
  const serverSync = useServerSync()()
  const platform = usePlatform()
  return createRuyingLoginState({
    authorize: () =>
      serverSDK.client.provider.oauth.authorize(
        { providerID: RUYING_PROVIDER_ID, method: 0 },
        { throwOnError: true },
      ),
    openLink: (url) => platform.openLink(url),
    callback: () => serverSDK.client.provider.oauth.callback({ providerID: RUYING_PROVIDER_ID, method: 0 }),
    cancel: () => serverSDK.client.provider.oauth.cancel({ providerID: RUYING_PROVIDER_ID }),
    dispose: () => serverSDK.client.global.dispose().catch(() => undefined),
    bootstrap: () => serverSync.bootstrap(),
    status: () => serverSDK.client.provider.ruying.status(),
  })
}
```

Capturing the current SDK and sync object prevents a login started against one server from continuing against a newly selected server.

- [ ] **Step 5: Add the cancel button and platform-routed fallback link**

In `RuyingLogin`, treat both `pending` and `canceling` as the waiting view. Replace the current fallback anchor with this interaction block:

```tsx
<Show when={login.state.authUrl}>
  <a
    href={login.state.authUrl}
    onClick={(event) => {
      event.preventDefault()
      login.open()
    }}
    class="text-12-regular text-text-weak underline break-all"
  >
    {login.state.authUrl}
  </a>
</Show>
<Show when={login.state.message}>
  <p class="text-12-regular text-text-base">{login.state.message}</p>
</Show>
<Button
  variant="secondary"
  size="large"
  disabled={login.state.status === "canceling"}
  onClick={login.cancel}
>
  {login.state.status === "canceling" ? "正在取消…" : "取消登录"}
</Button>
```

Change the waiting condition from `login.state.status === "pending"` to:

```tsx
login.state.status === "pending" || login.state.status === "canceling"
```

- [ ] **Step 6: Replace the mounted reload test with an in-place gate-unlock test**

Replace `mounted RuyingLogin button wires authorize, callback, dispose, and reload` in `packages/app/src/components/ruying-wiring.test.tsx` with:

```ts
test("mounted login unlocks the gate in place after the disposed lifecycle refresh", async () => {
  let loggedIn = false
  let listener: ((event: { type: string }) => void) | undefined
  const current = runtime(false, [])
  current.client.provider.ruying.status = async () => ({ data: { loggedIn } })
  current.client.provider.oauth.authorize = async () => ({ data: { url: "https://sso.example/login" } })
  current.client.provider.oauth.callback = async () => {
    loggedIn = true
    return { data: true }
  }
  current.client.global.dispose = async () => {
    listener?.({ type: "global.disposed" })
  }
  current.event.on = (_scope, next) => {
    listener = next
    return () => undefined
  }
  setSync({ ready: true, bootstrap: async () => undefined })
  setSdk(current)
  const gate = mountGate()

  await settle()
  const start = [...gate.host.querySelectorAll("button")].find((button) => button.textContent?.includes("SSO 登录"))
  if (!start) throw new Error("login button not rendered")
  start.click()
  await settle()

  expect(gate.host.textContent).toContain("PROTECTED CHILD")
  expect(gate.host.textContent).not.toContain("SSO 登录")
  gate.dispose()
})
```

Remove the `spyOn(window.location, "reload")` setup and assertion and remove `spyOn` from the `bun:test` import when it has no remaining use; no reload call remains in the login path.

- [ ] **Step 7: Add a mounted cancellation wiring test**

Append to `packages/app/src/components/ruying-wiring.test.tsx`:

```ts
test("mounted login exposes a fallback url and cancels the pending callback", async () => {
  const callback = deferred<{ data?: boolean; error?: unknown }>()
  const calls: string[] = []
  const current = runtime(false, [])
  current.client.provider.oauth.authorize = async () => ({ data: { url: "https://sso.example/login" } })
  current.client.provider.oauth.callback = () => callback.promise
  current.client.provider.oauth.cancel = async () => {
    calls.push("cancel")
    return { data: true }
  }
  setSync({ ready: true, bootstrap: async () => undefined })
  setSdk(current)
  const gate = mountGate()

  await settle()
  const start = [...gate.host.querySelectorAll("button")].find((button) => button.textContent?.includes("SSO 登录"))
  if (!start) throw new Error("login button not rendered")
  start.click()
  await settle()

  expect(gate.host.querySelector("a")?.textContent).toBe("https://sso.example/login")
  const cancel = [...gate.host.querySelectorAll("button")].find((button) => button.textContent?.includes("取消登录"))
  if (!cancel) throw new Error("cancel button not rendered")
  cancel.click()
  await settle()

  expect(calls).toEqual(["cancel"])
  expect(gate.host.textContent).toContain("SSO 登录")
  callback.resolve({ error: new Error("canceled") })
  gate.dispose()
})
```

Reuse the `deferred` helper added to this test file in Step 1.

- [ ] **Step 8: Run wiring, state, and server-sync tests**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts ./src/components/ruying-login.test.tsx ./src/context/server-sync.test.ts
bun test --conditions=browser \
  --preload ./happydom.ts \
  --preload ./solid-test-preload.ts \
  ./src/components/ruying-wiring.test.tsx
```

Expected: all tests PASS with zero failures.

- [ ] **Step 9: Run App typecheck**

Run from `packages/app`:

```bash
bun typecheck
```

Expected: exit code 0.

- [ ] **Step 10: Commit the App controller and UI wiring**

```bash
git add \
  packages/app/src/context/server-sync.tsx \
  packages/app/src/components/ruying-login.tsx \
  packages/app/src/components/ruying-wiring.test.tsx
git commit -m "feat(app): wire system browser sso"
```

---

### Task 3: Gate the production legacy layout and the new layout once

**Files:**
- Create: `packages/app/src/ruying-layout-gate.test.ts`
- Modify: `packages/app/src/app.tsx:159-176`
- Modify: `packages/app/src/app.tsx:336-345`

**Interfaces:**
- Consumes: the existing `RuyingGate` component and the shared `ServerSDKProvider`/`ServerSyncProvider` composition.
- Produces: one `RuyingGate` inside `SelectedServerProviders`, inherited by `LegacyServerLayout` and `NewAppLayout`.

- [ ] **Step 1: Write the failing layout composition contract test**

Create `packages/app/src/ruying-layout-gate.test.ts`:

```ts
import { expect, test } from "bun:test"

test("the shared selected-server providers gate both visual layouts exactly once", async () => {
  const source = await Bun.file(new URL("app.tsx", import.meta.url)).text()
  const selected = source.slice(
    source.indexOf("function SelectedServerProviders"),
    source.indexOf("function LegacyServerLayout"),
  )
  const newLayout = source.slice(source.indexOf("function NewAppLayout"), source.indexOf("function DraftServerScopedProviders"))

  expect(selected).toContain("<RuyingGate>")
  expect(selected).toContain("<ServerSyncProvider>")
  expect(newLayout).not.toContain("<RuyingGate>")
  expect(source.match(/<RuyingGate>/g)).toHaveLength(1)
})
```

- [ ] **Step 2: Run the contract test and verify the RED state**

Run from `packages/app`:

```bash
bun test ./src/ruying-layout-gate.test.ts
```

Expected: FAIL because `RuyingGate` is currently inside `NewAppLayout`, not `SelectedServerProviders`.

- [ ] **Step 3: Move the gate into the shared selected-server providers**

Replace `SelectedServerProviders` in `packages/app/src/app.tsx` with:

```tsx
function SelectedServerProviders(props: ParentProps) {
  return (
    <ServerKey>
      <ServerSDKProvider>
        <ServerSyncProvider>
          <RuyingGate>{props.children}</RuyingGate>
        </ServerSyncProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
}
```

Replace `NewAppLayout` with:

```tsx
function NewAppLayout(props: ParentProps) {
  return (
    <SelectedServerProviders>
      <ServerScopedProviders>
        <NewLayout>{props.children}</NewLayout>
      </ServerScopedProviders>
    </SelectedServerProviders>
  )
}
```

`LegacyServerLayout` already uses `SelectedServerProviders`, so it gains the same gate without a second layout-specific branch.

- [ ] **Step 4: Run the layout contract and mounted gate tests**

Run from `packages/app`:

```bash
bun test ./src/ruying-layout-gate.test.ts
bun test --conditions=browser \
  --preload ./happydom.ts \
  --preload ./solid-test-preload.ts \
  ./src/components/ruying-wiring.test.tsx
```

Expected: all tests PASS with zero failures.

- [ ] **Step 5: Run all App unit tests and typecheck**

Run from `packages/app`:

```bash
bun test --conditions=browser \
  --preload ./happydom.ts \
  --preload ./solid-test-preload.ts \
  ./src
bun typecheck
```

Expected: both commands exit 0. Record any pre-existing unrelated failure separately; do not weaken or delete a test to make the suite pass.

- [ ] **Step 6: Commit the shared layout gate**

```bash
git add packages/app/src/app.tsx packages/app/src/ruying-layout-gate.test.ts
git commit -m "fix(app): gate legacy layout login"
```

---

### Task 4: Verify the production Desktop flow and rebuild unsigned macOS artifacts

**Files:**
- Verify: `packages/app`
- Verify: `packages/desktop`
- Generate ignored artifacts under: `packages/desktop/dist/unsigned-macos-arm64`

**Interfaces:**
- Consumes: Tasks 1-3 and `/Users/gwm/.codex/skills/packaging-ruying-code/scripts/package-macos.sh`.
- Produces: fresh unsigned `arm64`/`prod` DMG and ZIP files for user testing.

- [ ] **Step 1: Run focused login regression tests from the App package**

```bash
cd packages/app
bun test --preload ./happydom.ts ./src/components/ruying-login.test.tsx ./src/ruying-layout-gate.test.ts
bun test --conditions=browser \
  --preload ./happydom.ts \
  --preload ./solid-test-preload.ts \
  ./src/components/ruying-wiring.test.tsx
```

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run package typechecks**

```bash
cd packages/app
bun typecheck
cd ../desktop
bun typecheck
```

Expected: both commands exit 0.

- [ ] **Step 3: Run a fresh production App/Desktop build**

From `packages/desktop`:

```bash
env OPENCODE_CHANNEL=prod bun run build
```

Expected: exit code 0, with production resources selected.

- [ ] **Step 4: Rebuild the unsigned Apple Silicon DMG and ZIP with the personal packaging skill**

```bash
/Users/gwm/.codex/skills/packaging-ruying-code/scripts/package-macos.sh \
  --repo /Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem \
  --arch arm64 \
  --channel prod
```

Expected files:

```text
packages/desktop/dist/unsigned-macos-arm64/ruying-code-desktop-mac-arm64.dmg
packages/desktop/dist/unsigned-macos-arm64/ruying-code-desktop-mac-arm64.zip
packages/desktop/dist/unsigned-macos-arm64/mac-arm64/如影 Code.app
```

- [ ] **Step 5: Independently verify the artifacts**

Run from the repository worktree root:

```bash
out=packages/desktop/dist/unsigned-macos-arm64
app="$out/mac-arm64/如影 Code.app"
hdiutil verify "$out/ruying-code-desktop-mac-arm64.dmg"
unzip -tq "$out/ruying-code-desktop-mac-arm64.zip"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" = "cn.gwm.ruying-code"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$app/Contents/Info.plist")" = "如影 Code"
test "$(shasum -a 256 packages/desktop/icons/prod/icon.icns | awk '{print $1}')" = \
  "$(shasum -a 256 "$app/Contents/Resources/icon.icns" | awk '{print $1}')"
! codesign -dv --verbose=4 "$app" 2>&1 | grep -q "Developer ID Application"
shasum -a 256 \
  "$out/ruying-code-desktop-mac-arm64.dmg" \
  "$out/ruying-code-desktop-mac-arm64.zip"
```

Expected: DMG and ZIP integrity checks pass, Bundle ID/name/icon match production branding, no Developer ID identity is present, and two fresh SHA-256 values are printed.

- [ ] **Step 6: Confirm the worktree contains no generated tracked changes**

```bash
git status --short
git diff --check
```

Expected: no uncommitted tracked changes and no whitespace errors. The ignored DMG/ZIP remain available for testing.

---

## Completion Criteria

- The state-machine tests prove automatic URL opening happens before callback waiting.
- Cancellation invalidates the callback and returns to a retryable login state.
- Successful login performs dispose, bootstrap, and authoritative status verification without reload.
- The shared selected-server provider layer contains exactly one `RuyingGate` for both layouts.
- App unit tests and App/Desktop typechecks pass.
- A fresh unsigned arm64/prod DMG and ZIP pass independent integrity, identity, icon, and signature checks.
