import { expect, test } from "bun:test"
import { createRuyingGateState, createRuyingLoginState, readRuyingUser } from "./ruying-login"

type StatusResult = { data?: { loggedIn: boolean }; error?: unknown }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

test("requires identity metadata instead of a bare api key", () => {
  expect(readRuyingUser({ apiKey: "sk-existing" })).toBeUndefined()
  expect(readRuyingUser({ ruyingUser: { employeeId: "GW001", displayName: "张三", email: "" } })).toEqual({
    employeeId: "GW001",
    displayName: "张三",
    email: "",
  })
})

test("keeps the gate checking while authoritative status is pending", async () => {
  const status = deferred<StatusResult>()
  const gate = createRuyingGateState(() => status.promise)
  const checking = gate.check()

  expect(gate.state.status).toBe("checking")
  status.resolve({ data: { loggedIn: false } })
  await checking
})

test("authoritative logged-in status unlocks a zero-model workspace", async () => {
  const gate = createRuyingGateState(async () => ({ data: { loggedIn: true } }))

  await gate.check()

  expect(gate.state.status).toBe("loggedIn")
})

test("authoritative logged-out status exposes only the login state", async () => {
  const gate = createRuyingGateState(async () => ({ data: { loggedIn: false } }))

  await gate.check()

  expect(gate.state.status).toBe("loggedOut")
})

test("lifecycle logout removes gate access to children", async () => {
  let loggedIn = true
  let listener: ((event: { type: string }) => void) | undefined
  const gate = createRuyingGateState(async () => ({ data: { loggedIn } }))
  const deactivate = gate.activate({
    status: async () => ({ data: { loggedIn } }),
    subscribe: (next) => {
      listener = next
      return () => undefined
    },
  })
  await Promise.resolve()
  expect(gate.state.status).toBe("loggedIn")

  loggedIn = false
  listener?.({ type: "global.disposed" })
  await Promise.resolve()
  expect(gate.state.status).toBe("loggedOut")
  deactivate()
})

test("gate replaces lifecycle listener and ignores stale status", async () => {
  const first = deferred<StatusResult>()
  const second = deferred<StatusResult>()
  const removed: string[] = []
  const gate = createRuyingGateState(() => first.promise)
  gate.activate({
    status: () => first.promise,
    subscribe: () => () => removed.push("first"),
  })
  const stop = gate.activate({
    status: () => second.promise,
    subscribe: () => () => removed.push("second"),
  })

  second.resolve({ data: { loggedIn: false } })
  await second.promise
  await Promise.resolve()
  first.resolve({ data: { loggedIn: true } })
  await first.promise
  await Promise.resolve()

  expect(gate.state.status).toBe("loggedOut")
  expect(removed).toEqual(["first"])
  stop()
  expect(removed).toEqual(["first", "second"])
})

async function verifyStatusRetry(first: () => Promise<StatusResult>) {
  let calls = 0
  const gate = createRuyingGateState(async () => {
    calls++
    if (calls === 1) return first()
    return { data: { loggedIn: true } }
  })

  await gate.check()
  expect(gate.state.status).toBe("error")
  expect(gate.state.message).toContain("重试")

  await gate.check()
  expect(gate.state.status).toBe("loggedIn")
  expect(calls).toBe(2)
}

test("rejected status remains an error until a status-only retry succeeds", async () => {
  await verifyStatusRetry(() => Promise.reject(new Error("offline")))
})

test("status error response remains an error until a status-only retry succeeds", async () => {
  await verifyStatusRetry(async () => ({ error: new Error("unavailable") }))
})

test("retry click ignores the Solid event and invokes authoritative status", async () => {
  let calls = 0
  const gate = createRuyingGateState(async () => {
    calls++
    if (calls === 1) return { error: new Error("offline") }
    return { data: { loggedIn: true } }
  })
  await gate.check()
  expect(gate.state.status).toBe("error")

  Reflect.apply(gate.retry, undefined, [{ type: "click" }])
  await Promise.resolve()

  expect(calls).toBe(2)
  expect(gate.state.status).toBe("loggedIn")
})

test("authorize failure returns to a retryable login state", async () => {
  const login = createRuyingLoginState({
    authorize: () => Promise.reject(new Error("authorize failed")),
    openLink: () => undefined,
    callback: async () => ({ data: true }),
    cancel: async () => ({ data: true }),
    dispose: async () => undefined,
    bootstrap: async () => undefined,
    status: async () => ({ data: { loggedIn: true } }),
  })

  await login.login()

  expect(login.state.status).toBe("error")
  expect(login.state.message).toContain("无法启动 GWM SSO 登录")
})

test("callback failure returns to a retryable login state", async () => {
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => undefined,
    callback: async () => ({ error: new Error("callback failed") }),
    cancel: async () => ({ data: true }),
    dispose: async () => undefined,
    bootstrap: async () => undefined,
    status: async () => ({ data: { loggedIn: true } }),
  })

  await login.login()

  expect(login.state.status).toBe("error")
  expect(login.state.message).toContain("登录失败，请重试")
})

test("successful login awaits dispose before refreshing in place", async () => {
  const disposing = deferred<void>()
  const events: string[] = []
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => events.push("open"),
    callback: async () => {
      events.push("callback")
      return { data: true }
    },
    cancel: async () => ({ data: true }),
    dispose: async () => {
      events.push("dispose:start")
      await disposing.promise
      events.push("dispose:end")
    },
    bootstrap: async () => events.push("bootstrap"),
    status: async () => {
      events.push("status")
      return { data: { loggedIn: true } }
    },
  })

  const authenticating = login.login()
  while (!events.includes("dispose:start")) await Bun.sleep(1)
  expect(events).toEqual(["open", "callback", "dispose:start"])

  disposing.resolve()
  await authenticating
  expect(events).toEqual(["open", "callback", "dispose:start", "dispose:end", "bootstrap", "status"])
})

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
