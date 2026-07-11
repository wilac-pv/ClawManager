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

test("authorize failure returns to a retryable login state", async () => {
  const login = createRuyingLoginState({
    authorize: () => Promise.reject(new Error("authorize failed")),
    callback: async () => ({ data: true }),
    dispose: async () => undefined,
    reload: () => undefined,
  })

  await login.login()

  expect(login.state.status).toBe("error")
  expect(login.state.message).toContain("authorize failed")
})

test("callback failure returns to a retryable login state", async () => {
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    callback: async () => ({ error: new Error("callback failed") }),
    dispose: async () => undefined,
    reload: () => undefined,
  })

  await login.login()

  expect(login.state.status).toBe("error")
  expect(login.state.message).toContain("登录失败，请重试")
})

test("successful login awaits dispose before reloading", async () => {
  const disposing = deferred<void>()
  const events: string[] = []
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    callback: async () => {
      events.push("callback")
      return { data: true }
    },
    dispose: async () => {
      events.push("dispose:start")
      await disposing.promise
      events.push("dispose:end")
    },
    reload: () => events.push("reload"),
  })

  const authenticating = login.login()
  while (!events.includes("dispose:start")) await Bun.sleep(1)
  expect(events).toEqual(["callback", "dispose:start"])

  disposing.resolve()
  await authenticating
  expect(events).toEqual(["callback", "dispose:start", "dispose:end", "reload"])
})
