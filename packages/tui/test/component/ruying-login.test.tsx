/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { RuyingLoginGate } from "../../src/component/ruying-login"
import { SDKProvider } from "../../src/context/sdk"
import { SyncContext, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { KVProvider } from "../../src/context/kv"
import { TuiConfigProvider } from "../../src/config"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { eventSource, json } from "../fixture/tui-sdk"

type Status = { loggedIn: boolean; user?: { employeeId?: string; displayName?: string; email?: string } }
type Result = { status?: number; data?: unknown }

async function waitFor(check: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

async function mount(input: {
  status: (call: number) => Status | Promise<Status>
  authorize?: (call: number) => Result | Promise<Result>
  callback?: (call: number) => Result | Promise<Result>
  cancel?: (call: number) => Result | Promise<Result>
  logout?: (call: number) => Result | Promise<Result>
}) {
  const root = await tmpdir()
  const state = path.join(root.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const calls: string[] = []
  const count = new Map<string, number>()
  const next = (key: string) => {
    const value = (count.get(key) ?? 0) + 1
    count.set(key, value)
    return value
  }
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const source = request instanceof Request ? request : new Request(request, init)
    const url = new URL(source.url)
    const key = `${source.method} ${url.pathname}`
    calls.push(key)
    if (key === "GET /provider/ruying/session") return json(await input.status(next(key)))
    if (key === "POST /provider/ruying/oauth/authorize") {
      const call = next(key)
      const result = (await input.authorize?.(call)) ?? {
        data: { method: "auto", url: "https://sso.example/login", instructions: "login" },
      }
      return json(result.data ?? { message: "authorize failed" }, { status: result.status ?? 200 })
    }
    if (key === "POST /provider/ruying/oauth/callback") {
      const call = next(key)
      const result = (await input.callback?.(call)) ?? { data: true }
      return json(result.data ?? { message: "callback failed" }, { status: result.status ?? 200 })
    }
    if (key === "POST /provider/ruying/oauth/cancel") {
      const call = next(key)
      const result = (await input.cancel?.(call)) ?? { data: true }
      return json(result.data ?? { message: "cancel failed" }, { status: result.status ?? 200 })
    }
    if (key === "DELETE /provider/ruying/session") {
      const call = next(key)
      const result = (await input.logout?.(call)) ?? { data: true }
      return json(result.data ?? { message: "logout failed" }, { status: result.status ?? 200 })
    }
    if (key === "POST /global/dispose") {
      next(key)
      return json(true)
    }
    throw new Error(`unexpected request: ${key}`)
  }) as typeof globalThis.fetch
  const sync = {
    data: { provider_next: { all: [], default: {}, connected: [] } },
    async bootstrap() {
      calls.push("bootstrap")
    },
  } as unknown as ReturnType<typeof useSync>

  const app = await testRender(
    () => (
      <TestTuiContexts directory={root.path} paths={{ state }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <SDKProvider url="http://test" directory={root.path} fetch={fetch} events={eventSource()}>
                <SyncContext.Provider value={sync}>
                  <RuyingLoginGate>
                    <text>WORKSPACE</text>
                  </RuyingLoginGate>
                </SyncContext.Provider>
              </SDKProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )

  return {
    app,
    calls,
    count: (key: string) => count.get(key) ?? 0,
    async frame() {
      await app.renderOnce()
      return app.captureCharFrame()
    },
    async cleanup() {
      app.renderer.destroy()
      await root[Symbol.asyncDispose]()
    },
  }
}

test("authoritative status unlocks a zero-model session and renders the user", async () => {
  const gate = await mount({
    status: () => ({ loggedIn: true, user: { employeeId: "GW001", displayName: "张三" } }),
  })
  try {
    await waitFor(() => gate.count("GET /provider/ruying/session") === 1)
    const frame = await gate.frame()
    expect(frame).toContain("WORKSPACE")
    expect(frame).toContain("张三 (GW001)")
    expect(gate.calls).not.toContain("GET /provider")
  } finally {
    await gate.cleanup()
  }
})

test("authorize failure leaves a retryable login screen", async () => {
  const gate = await mount({ status: () => ({ loggedIn: false }), authorize: () => ({ status: 400 }) })
  try {
    await waitFor(() => gate.count("GET /provider/ruying/session") === 1)
    gate.app.mockInput.pressEnter()
    await waitFor(() => gate.count("POST /provider/ruying/oauth/authorize") === 1)
    expect(await gate.frame()).toContain("无法启动 GWM SSO 登录")
  } finally {
    await gate.cleanup()
  }
})

test("callback failure leaves a retryable login screen", async () => {
  const gate = await mount({ status: () => ({ loggedIn: false }), callback: () => ({ status: 400 }) })
  try {
    await waitFor(() => gate.count("GET /provider/ruying/session") === 1)
    gate.app.mockInput.pressEnter()
    await waitFor(() => gate.count("POST /provider/ruying/oauth/callback") === 1)
    expect(await gate.frame()).toContain("登录失败，请重试")
  } finally {
    await gate.cleanup()
  }
})

test("Escape retries safely while an older callback overlaps and refreshes in order", async () => {
  const first = deferred<Result>()
  const cancel = deferred<Result>()
  const gate = await mount({
    status: (call) => (call === 1 ? { loggedIn: false } : { loggedIn: true, user: { employeeId: "GW001" } }),
    callback: (call) => (call === 1 ? first.promise : { data: true }),
    cancel: () => cancel.promise,
  })
  try {
    await waitFor(() => gate.count("GET /provider/ruying/session") === 1)
    gate.app.mockInput.pressEnter()
    await waitFor(() => gate.count("POST /provider/ruying/oauth/callback") === 1)
    gate.app.mockInput.pressEscape()
    await waitFor(() => gate.count("POST /provider/ruying/oauth/cancel") === 1)
    expect(await gate.frame()).toContain("正在等待浏览器完成 SSO 登录")
    cancel.resolve({ data: true })
    await gate.app.waitForFrame((frame) => frame.includes("SSO 登录"))
    expect(await gate.frame()).toContain("SSO 登录")

    gate.app.mockInput.pressEnter()
    await waitFor(() => gate.count("GET /provider/ruying/session") === 2)
    expect(await gate.frame()).toContain("WORKSPACE")
    expect(gate.calls.slice(-4)).toEqual([
      "POST /provider/ruying/oauth/callback",
      "POST /global/dispose",
      "bootstrap",
      "GET /provider/ruying/session",
    ])

    first.resolve({ status: 400 })
    await Bun.sleep(20)
    expect(gate.count("POST /global/dispose")).toBe(1)
    expect(await gate.frame()).toContain("WORKSPACE")
  } finally {
    await gate.cleanup()
  }
})

test("post-login status failure clears pending and allows retry", async () => {
  const gate = await mount({ status: () => ({ loggedIn: false }) })
  try {
    await waitFor(() => gate.count("GET /provider/ruying/session") === 1)
    gate.app.mockInput.pressEnter()
    await waitFor(() => gate.count("GET /provider/ruying/session") === 2)
    expect(await gate.frame()).toContain("登录状态未生效，请重试")
    gate.app.mockInput.pressEnter()
    await waitFor(() => gate.count("POST /provider/ruying/oauth/authorize") === 2)
  } finally {
    await gate.cleanup()
  }
})

test("keyboard logout recovers from failure without client-side disposal", async () => {
  const gate = await mount({
    status: (call) => (call === 1 ? { loggedIn: true, user: { employeeId: "GW001" } } : { loggedIn: false }),
    logout: (call) => (call === 1 ? { status: 500 } : { data: true }),
  })
  try {
    await waitFor(() => gate.count("GET /provider/ruying/session") === 1)
    gate.app.mockInput.pressKey("l")
    await Bun.sleep(20)
    expect(gate.count("DELETE /provider/ruying/session")).toBe(0)

    gate.app.mockInput.pressKey("l", { ctrl: true, shift: true })
    await waitFor(() => gate.count("DELETE /provider/ruying/session") === 1)
    expect(await gate.frame()).toContain("退出失败，请重试")
    expect(await gate.frame()).toContain("WORKSPACE")

    gate.app.mockInput.pressKey("l", { ctrl: true, shift: true })
    await waitFor(() => gate.count("GET /provider/ruying/session") === 2)
    expect(await gate.frame()).toContain("SSO 登录")
    expect(gate.count("POST /global/dispose")).toBe(0)
    expect(gate.calls.slice(-3)).toEqual(["DELETE /provider/ruying/session", "bootstrap", "GET /provider/ruying/session"])
  } finally {
    await gate.cleanup()
  }
})
