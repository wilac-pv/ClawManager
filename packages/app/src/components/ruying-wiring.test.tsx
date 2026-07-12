import { afterEach, expect, mock, test } from "bun:test"
import { createComponent, createEffect, createRoot, createSignal } from "solid-js"
import { insert, render } from "solid-js/web"

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

const [sdk, setSdk] = createSignal<Runtime>()
const [sync, setSync] = createSignal({ ready: false, bootstrap: async () => undefined })
const openLink = mock((_url: string) => undefined)

mock.module("@/context/server-sdk", () => ({ useServerSDK: () => sdk }))
mock.module("@/context/server-sync", () => ({ useServerSync: () => sync }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ openLink }) }))
mock.module("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: unknown; onClick?: () => void; disabled?: boolean }) => {
    const element = document.createElement("button")
    element.addEventListener("click", () => props.onClick?.())
    createEffect(() => (element.disabled = props.disabled ?? false))
    insert(element, () => props.children)
    return element
  },
}))
mock.module("@opencode-ai/ui/logo", () => ({
  Splash: () => document.createElement("div"),
}))

const { createRuyingGateController, createRuyingLoginController, RuyingGate, RuyingLogin } =
  await import("./ruying-login")

afterEach(() => {
  document.body.innerHTML = ""
  openLink.mockReset()
  openLink.mockImplementation((_url: string) => undefined)
})

function runtime(loggedIn: boolean, removed: string[]): Runtime {
  return {
    client: {
      provider: {
        ruying: { status: async () => ({ data: { loggedIn } }) },
        oauth: { authorize: async () => ({}), callback: async () => ({}), cancel: async () => ({ data: true }) },
      },
      global: { dispose: async () => undefined },
    },
    event: { on: () => () => removed.push(loggedIn ? "logged-in" : "logged-out") },
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Bun.sleep(1)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

test("gate controller wires readiness and replaces the active SDK subscription", async () => {
  const removed: string[] = []
  setSync({ ready: false, bootstrap: async () => undefined })
  setSdk(runtime(true, removed))
  let controller!: ReturnType<typeof createRuyingGateController>
  const dispose = createRoot((close) => {
    controller = createRuyingGateController()
    return close
  })

  expect(controller.ready()).toBe(false)
  expect(controller.gate.state.status).toBe("checking")
  setSync({ ready: true, bootstrap: async () => undefined })
  await settle()
  expect(controller.gate.state.status).toBe("loggedIn")

  setSdk(runtime(false, removed))
  await settle()
  expect(removed).toEqual(["logged-in"])
  expect(controller.gate.state.status).toBe("loggedOut")

  dispose()
  expect(removed).toEqual(["logged-in", "logged-out"])
})

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
  openLink.mockImplementation((url: string) => {
    calls.push(`open:${url}`)
  })
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

test("unmount invalidates a pending callback before it can refresh the captured server", async () => {
  const callback = deferred<{ data?: boolean; error?: unknown }>()
  const calls: string[] = []
  const current = runtime(false, [])
  current.client.provider.oauth.authorize = async () => ({ data: { url: "https://sso.example/login" } })
  current.client.provider.oauth.callback = () => callback.promise
  current.client.global.dispose = async () => calls.push("dispose")
  current.client.provider.ruying.status = async () => {
    calls.push("status")
    return { data: { loggedIn: true } }
  }
  setSync({
    ready: true,
    bootstrap: async () => {
      calls.push("bootstrap")
    },
  })
  setSdk(current)
  const login = mountLogin()
  const start = [...login.host.querySelectorAll("button")].find((button) => button.textContent?.includes("SSO 登录"))
  if (!start) throw new Error("login button not rendered")
  start.click()
  await Promise.resolve()
  login.dispose()
  callback.resolve({ data: true })
  await settle()

  expect(calls).toEqual([])
})

test("mounted RuyingGate renders checking, logged-out, and logged-in child states", async () => {
  const removed: string[] = []
  setSync({ ready: false, bootstrap: async () => undefined })
  setSdk(runtime(false, removed))
  const first = mountGate()
  expect(first.host.textContent).toContain("正在检查 GWM SSO 登录状态")

  setSync({ ready: true, bootstrap: async () => undefined })
  await settle()
  expect(first.host.textContent).toContain("SSO 登录")
  expect(first.host.textContent).not.toContain("PROTECTED CHILD")
  first.dispose()

  setSync({ ready: true, bootstrap: async () => undefined })
  setSdk(runtime(true, removed))
  const second = mountGate()
  await settle()
  expect(second.host.textContent).toContain("PROTECTED CHILD")
  expect(second.host.textContent).not.toContain("SSO 登录")
  second.dispose()
})

test("mounted RuyingGate renders an error and retry unlocks the protected child", async () => {
  let calls = 0
  const current = runtime(false, [])
  current.client.provider.ruying.status = async () => {
    calls++
    if (calls === 1) return { error: new Error("status failed") } as never
    return { data: { loggedIn: true } }
  }
  setSync({ ready: true, bootstrap: async () => undefined })
  setSdk(current)
  const gate = mountGate()

  await settle()
  expect(gate.host.textContent).toContain("无法检查 GWM SSO 登录状态")
  const retry = [...gate.host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("重试检查登录状态"),
  )
  if (!retry) throw new Error("retry button not rendered")
  retry.click()
  await settle()

  expect(calls).toBe(2)
  expect(gate.host.textContent).toContain("PROTECTED CHILD")
  gate.dispose()
})

test("mounted login explicitly unlocks the gate without a disposed lifecycle event", async () => {
  let loggedIn = false
  const current = runtime(false, [])
  current.client.provider.ruying.status = async () => ({ data: { loggedIn } })
  current.client.provider.oauth.authorize = async () => ({ data: { url: "https://sso.example/login" } })
  current.client.provider.oauth.callback = async () => {
    loggedIn = true
    return { data: true }
  }
  current.client.global.dispose = async () => undefined
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

test("mounted dispose failure leaves the outer gate locked with a retryable error", async () => {
  const current = runtime(false, [])
  current.client.provider.oauth.authorize = async () => ({ data: { url: "https://sso.example/login" } })
  current.client.provider.oauth.callback = async () => ({ data: true })
  current.client.global.dispose = async () => Promise.reject(new Error("secret dispose detail"))
  setSync({ ready: true, bootstrap: async () => undefined })
  setSdk(current)
  const gate = mountGate()

  await settle()
  const start = [...gate.host.querySelectorAll("button")].find((button) => button.textContent?.includes("SSO 登录"))
  if (!start) throw new Error("login button not rendered")
  start.click()
  await settle()

  expect(gate.host.textContent).toContain("无法刷新登录状态，请重试")
  expect(gate.host.textContent).not.toContain("PROTECTED CHILD")
  gate.dispose()
})

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
  await settle()
  gate.dispose()
})

function mountGate() {
  const host = document.createElement("div")
  document.body.append(host)
  const child = document.createElement("div")
  child.textContent = "PROTECTED CHILD"
  const dispose = render(
    () =>
      createComponent(RuyingGate, {
        get children() {
          return child
        },
      }),
    host,
  )
  return { host, dispose }
}

function mountLogin() {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(RuyingLogin, {}), host)
  return { host, dispose }
}
