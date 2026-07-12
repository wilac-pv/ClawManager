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

test("an authenticated handoff cannot unlock a replacement server runtime", async () => {
  const pending = deferred<StatusResult>()
  const gate = createRuyingGateState(() => pending.promise)
  gate.activate({ status: () => pending.promise, subscribe: () => () => undefined })
  const stale = gate.createLoginHandoff()
  gate.activate({ status: () => pending.promise, subscribe: () => () => undefined })

  stale.committed()
  stale.authenticated()

  expect(gate.state.status).toBe("checking")
})

test("a committed login suppresses disposed status refresh until its explicit handoff", async () => {
  let loggedIn = false
  let listener: ((event: { type: string }) => void) | undefined
  const gate = createRuyingGateState(async () => ({ data: { loggedIn } }))
  gate.activate({
    status: async () => ({ data: { loggedIn } }),
    subscribe: (next) => {
      listener = next
      return () => undefined
    },
  })
  await Promise.resolve()
  expect(gate.state.status).toBe("loggedOut")
  const handoff = gate.createLoginHandoff()

  handoff.committed()
  loggedIn = true
  listener?.({ type: "global.disposed" })
  await Promise.resolve()

  expect(gate.state.status).toBe("loggedOut")
  handoff.authenticated()
  expect(gate.state.status).toBe("loggedIn")
})

test("a failed committed login remains locked despite persisted-credential lifecycle events", async () => {
  let loggedIn = true
  let listener: ((event: { type: string }) => void) | undefined
  const gate = createRuyingGateState(async () => ({ data: { loggedIn } }))
  gate.activate({
    status: async () => ({ data: { loggedIn } }),
    subscribe: (next) => {
      listener = next
      return () => undefined
    },
  })
  await Promise.resolve()
  const handoff = gate.createLoginHandoff()
  handoff.committed()
  listener?.({ type: "global.disposed" })
  await Promise.resolve()
  handoff.failed()

  expect(gate.state.status).toBe("loggedOut")
  listener?.({ type: "server.connected" })
  await Promise.resolve()
  expect(gate.state.status).toBe("loggedOut")
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
  expect(gate.state.message).toBe("无法检查 GWM SSO 登录状态，请重试。")

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

test("desktop login does not reopen the provider-owned browser URL", async () => {
  const callback = deferred<{ data: boolean }>()
  const opened: string[] = []
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: (url) => opened.push(url),
    callback: () => callback.promise,
    cancel: async () => ({ data: true }),
    dispose: async () => undefined,
    bootstrap: async () => undefined,
    status: async () => ({ data: { loggedIn: true } }),
  })

  const authenticating = login.login()
  await Promise.resolve()

  expect(opened).toEqual([])
  callback.resolve({ data: false })
  await authenticating
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
  expect(events).toEqual(["callback", "dispose:start"])

  disposing.resolve()
  await authenticating
  expect(events).toEqual(["callback", "dispose:start", "dispose:end", "bootstrap", "status"])
})

test("waits for the provider-owned browser oauth callback", async () => {
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

  expect(events).toEqual(["callback"])
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

  expect(events).toEqual(["callback", "dispose", "bootstrap", "status"])
  expect(login.state.status).toBe("error")
  expect(login.state.message).toContain("登录状态未生效")
})

test("a failed manual browser reopen keeps the fallback url and callback active", async () => {
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
  login.open()
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

test("invalidating a pending login prevents its late callback from refreshing the old server", async () => {
  const callback = deferred<{ data?: boolean; error?: unknown }>()
  const events: string[] = []
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => undefined,
    callback: () => callback.promise,
    cancel: async () => ({ data: true }),
    dispose: async () => events.push("dispose"),
    bootstrap: async () => events.push("bootstrap"),
    status: async () => {
      events.push("status")
      return { data: { loggedIn: true } }
    },
    authenticated: () => events.push("authenticated"),
  })

  const pending = login.login()
  await Promise.resolve()
  login.invalidate()
  callback.resolve({ data: true })
  await pending

  expect(events).toEqual([])
  expect(login.state.status).toBe("idle")
})

test("cleanup during the committed dispose lifecycle preserves successful refresh and unlock", async () => {
  const events: string[] = []
  let login!: ReturnType<typeof createRuyingLoginState>
  login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => undefined,
    callback: async () => ({ data: true }),
    cancel: async () => ({ data: true }),
    dispose: async () => {
      events.push("dispose")
      login.invalidate()
    },
    bootstrap: async () => events.push("bootstrap"),
    status: async () => {
      events.push("status")
      return { data: { loggedIn: true } }
    },
    authenticated: () => events.push("authenticated"),
  })

  await login.login()

  expect(events).toEqual(["dispose", "bootstrap", "status", "authenticated"])
})

test("a newer attempt makes an older dispose continuation phase-stale", async () => {
  const disposing = deferred<void>()
  const events: string[] = []
  let callbacks = 0
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => undefined,
    callback: async () => ({ data: ++callbacks === 1 }),
    cancel: async () => ({ data: true }),
    dispose: async () => {
      events.push("dispose")
      await disposing.promise
    },
    bootstrap: async () => events.push("bootstrap"),
    status: async () => ({ data: { loggedIn: true } }),
    authenticated: () => events.push("authenticated"),
  })

  const stale = login.login()
  while (!events.includes("dispose")) await Bun.sleep(1)
  await login.login()
  disposing.resolve()
  await stale

  expect(events).toEqual(["dispose"])
  expect(login.state.status).toBe("error")
})

test("newer attempts ignore older bootstrap and status continuations", async () => {
  for (const boundary of ["bootstrap", "status"] as const) {
    const paused = deferred<void>()
    const events: string[] = []
    let callbacks = 0
    const login = createRuyingLoginState({
      authorize: async () => ({ data: { url: "https://sso.example/login" } }),
      openLink: () => undefined,
      callback: async () => ({ data: ++callbacks === 1 }),
      cancel: async () => ({ data: true }),
      dispose: async () => events.push("dispose"),
      bootstrap: async () => {
        events.push("bootstrap")
        if (boundary === "bootstrap") await paused.promise
      },
      status: async () => {
        events.push("status")
        if (boundary === "status") await paused.promise
        return { data: { loggedIn: true } }
      },
      authenticated: () => events.push("authenticated"),
    })

    const stale = login.login()
    while (!events.includes(boundary)) await Bun.sleep(1)
    await login.login()
    paused.resolve()
    await stale

    expect(events).not.toContain("authenticated")
    expect(events.filter((event) => event === "status")).toHaveLength(boundary === "bootstrap" ? 0 : 1)
  }
})

test("credential finalization cannot be canceled at dispose, bootstrap, or status", async () => {
  for (const boundary of ["dispose", "bootstrap", "status"] as const) {
    const paused = deferred<void>()
    const events: string[] = []
    const login = createRuyingLoginState({
      authorize: async () => ({ data: { url: "https://sso.example/login" } }),
      openLink: () => undefined,
      callback: async () => ({ data: true }),
      cancel: async () => {
        events.push("cancel")
        return { data: true }
      },
      dispose: async () => {
        events.push("dispose")
        if (boundary === "dispose") await paused.promise
      },
      bootstrap: async () => {
        events.push("bootstrap")
        if (boundary === "bootstrap") await paused.promise
      },
      status: async () => {
        events.push("status")
        if (boundary === "status") await paused.promise
        return { data: { loggedIn: true } }
      },
      committed: () => events.push("committed"),
      failed: () => events.push("failed"),
      authenticated: () => events.push("authenticated"),
    })

    const finalizing = login.login()
    while (!events.includes(boundary)) await Bun.sleep(1)
    expect(login.state.status).toBe("refreshing")
    await login.cancel()
    expect(events).not.toContain("cancel")
    paused.resolve()
    await finalizing
    expect(events.at(-1)).toBe("authenticated")
  }
})

test("refresh failure reports the failed handoff without reporting authentication", async () => {
  const events: string[] = []
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => undefined,
    callback: async () => ({ data: true }),
    cancel: async () => ({ data: true }),
    dispose: async () => undefined,
    bootstrap: async () => Promise.reject(new Error("offline")),
    status: async () => ({ data: { loggedIn: true } }),
    committed: () => events.push("committed"),
    failed: () => events.push("failed"),
    authenticated: () => events.push("authenticated"),
  })

  await login.login()

  expect(events).toEqual(["committed", "failed"])
  expect(login.state.status).toBe("error")
})

test("dispose failure stays retryable and never reports authentication", async () => {
  const events: string[] = []
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => undefined,
    callback: async () => ({ data: true }),
    cancel: async () => ({ data: true }),
    dispose: async () => Promise.reject(new Error("secret dispose detail")),
    bootstrap: async () => events.push("bootstrap"),
    status: async () => ({ data: { loggedIn: true } }),
    authenticated: () => events.push("authenticated"),
  })

  await login.login()

  expect(login.state.status).toBe("error")
  expect(login.state.message).toBe("无法刷新登录状态，请重试。")
  expect(events).toEqual([])
})

test("authoritative success explicitly unlocks the owning gate", async () => {
  const events: string[] = []
  const login = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => undefined,
    callback: async () => ({ data: true }),
    cancel: async () => ({ data: true }),
    dispose: async () => events.push("dispose"),
    bootstrap: async () => events.push("bootstrap"),
    status: async () => {
      events.push("status")
      return { data: { loggedIn: true } }
    },
    authenticated: () => events.push("authenticated"),
  })

  await login.login()

  expect(events).toEqual(["dispose", "bootstrap", "status", "authenticated"])
})

test("reserves a web tab before authorize and navigates it after authorization", async () => {
  const events: string[] = []
  const login = createRuyingLoginState({
    reserveLink: () => {
      events.push("reserve")
      return { navigate: (url) => events.push(`navigate:${url}`), close: () => events.push("close") }
    },
    authorize: async () => {
      events.push("authorize")
      return { data: { url: "https://sso.example/login" } }
    },
    openLink: () => events.push("open"),
    callback: async () => {
      events.push("callback")
      return { error: new Error("stopped") }
    },
    cancel: async () => ({ data: true }),
    dispose: async () => undefined,
    bootstrap: async () => undefined,
    status: async () => ({ data: { loggedIn: true } }),
  })

  await login.login()

  expect(events).toEqual(["reserve", "authorize", "navigate:https://sso.example/login", "callback"])
})

test("blocked web tab reservation keeps the credential-safe fallback notice", async () => {
  const callback = deferred<{ data?: boolean; error?: unknown }>()
  const login = createRuyingLoginState({
    reserveLink: () => undefined,
    authorize: async () => ({ data: { url: "https://sso.example/private?token=secret" } }),
    openLink: () => undefined,
    callback: () => callback.promise,
    cancel: async () => ({ data: true }),
    dispose: async () => undefined,
    bootstrap: async () => undefined,
    status: async () => ({ data: { loggedIn: true } }),
  })

  const pending = login.login()
  await Promise.resolve()

  expect(login.state.message).toBe("浏览器阻止了新标签页，请点击或复制下方链接继续登录。")
  expect(login.state.message).not.toContain("secret")
  callback.resolve({ error: new Error("stopped") })
  await pending
})

test("a stale authorize response cannot close a newer attempt's reserved tab", async () => {
  const first = deferred<{ data?: { url?: string }; error?: unknown }>()
  const second = deferred<{ data?: { url?: string }; error?: unknown }>()
  const events: string[] = []
  let authorizations = 0
  let reservations = 0
  const login = createRuyingLoginState({
    reserveLink: () => {
      const id = ++reservations
      return { navigate: () => undefined, close: () => events.push(`close:${id}`) }
    },
    authorize: () => (++authorizations === 1 ? first.promise : second.promise),
    openLink: () => undefined,
    callback: async () => ({ data: true }),
    cancel: async () => ({ data: true }),
    dispose: async () => undefined,
    bootstrap: async () => undefined,
    status: async () => ({ data: { loggedIn: true } }),
  })

  const stale = login.login()
  await Promise.resolve()
  const current = login.login()
  first.resolve({ data: { url: "https://sso.example/old" } })
  await stale

  expect(events).not.toContain("close:2")
  second.resolve({ error: new Error("stop") })
  await current
  expect(events).toContain("close:2")
})

test("cancel, bootstrap, and status failures use bounded retryable messages", async () => {
  const canceled = deferred<{ data?: boolean; error?: unknown }>()
  const canceling = createRuyingLoginState({
    authorize: async () => ({ data: { url: "https://sso.example/login" } }),
    openLink: () => undefined,
    callback: () => canceled.promise,
    cancel: async () => ({ error: new Error("secret cancel detail") }),
    dispose: async () => undefined,
    bootstrap: async () => undefined,
    status: async () => ({ data: { loggedIn: true } }),
  })
  const pending = canceling.login()
  await Promise.resolve()
  await canceling.cancel()
  expect(canceling.state.message).toBe("取消登录失败，请重试。")
  canceled.resolve({ error: new Error("stale callback detail") })
  await pending

  for (const failure of ["bootstrap", "status"] as const) {
    const login = createRuyingLoginState({
      authorize: async () => ({ data: { url: "https://sso.example/login" } }),
      openLink: () => undefined,
      callback: async () => ({ data: true }),
      cancel: async () => ({ data: true }),
      dispose: async () => undefined,
      bootstrap: async () => {
        if (failure === "bootstrap") throw new Error("secret bootstrap detail")
      },
      status: async () => {
        if (failure === "status") throw new Error("secret status detail")
        return { data: { loggedIn: true } }
      },
    })
    await login.login()
    expect(login.state.message).toBe("无法刷新登录状态，请重试。")
  }
})
