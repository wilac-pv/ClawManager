import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { createComponent, createEffect, createRoot, createSignal } from "solid-js"
import { insert, render } from "solid-js/web"

type Runtime = {
  client: {
    provider: {
      ruying: { status: () => Promise<{ data: { loggedIn: boolean } }> }
      oauth: { authorize: (...args: unknown[]) => Promise<unknown>; callback: (...args: unknown[]) => Promise<unknown> }
    }
    global: { dispose: () => Promise<unknown> }
  }
  event: { on: (_scope: string, listener: (event: { type: string }) => void) => () => void }
}

const [sdk, setSdk] = createSignal<Runtime>()
const [sync, setSync] = createSignal({ ready: false })

mock.module("@/context/server-sdk", () => ({ useServerSDK: () => sdk }))
mock.module("@/context/server-sync", () => ({ useServerSync: () => sync }))
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

const { createRuyingGateController, createRuyingLoginController, RuyingGate } = await import("./ruying-login")

afterEach(() => {
  document.body.innerHTML = ""
})

function runtime(loggedIn: boolean, removed: string[]) {
  return {
    client: {
      provider: {
        ruying: { status: async () => ({ data: { loggedIn } }) },
        oauth: { authorize: async () => ({}), callback: async () => ({}) },
      },
      global: { dispose: async () => undefined },
    },
    event: { on: () => () => removed.push(loggedIn ? "logged-in" : "logged-out") },
  } satisfies Runtime
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Bun.sleep(1)
}

test("gate controller wires readiness and replaces the active SDK subscription", async () => {
  const removed: string[] = []
  setSync({ ready: false })
  setSdk(runtime(true, removed))
  let controller!: ReturnType<typeof createRuyingGateController>
  const dispose = createRoot((close) => {
    controller = createRuyingGateController()
    return close
  })

  expect(controller.ready()).toBe(false)
  expect(controller.gate.state.status).toBe("checking")
  setSync({ ready: true })
  await settle()
  expect(controller.gate.state.status).toBe("loggedIn")

  setSdk(runtime(false, removed))
  await settle()
  expect(removed).toEqual(["logged-in"])
  expect(controller.gate.state.status).toBe("loggedOut")

  dispose()
  expect(removed).toEqual(["logged-in", "logged-out"])
})

test("login controller wires SDK authorize, callback, dispose, and reload in order", async () => {
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
  current.client.global.dispose = async () => {
    calls.push("dispose")
  }
  setSdk(current)

  let login!: ReturnType<typeof createRuyingLoginController>
  const dispose = createRoot((close) => {
    login = createRuyingLoginController(() => calls.push("reload"))
    return close
  })
  await login.login()

  expect(calls).toEqual(["authorize", "callback", "dispose", "reload"])
  dispose()
})

test("mounted RuyingGate renders checking, logged-out, and logged-in child states", async () => {
  const removed: string[] = []
  setSync({ ready: false })
  setSdk(runtime(false, removed))
  const first = mountGate()
  expect(first.host.textContent).toContain("正在检查 GWM SSO 登录状态")

  setSync({ ready: true })
  await settle()
  expect(first.host.textContent).toContain("SSO 登录")
  expect(first.host.textContent).not.toContain("PROTECTED CHILD")
  first.dispose()

  setSync({ ready: true })
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
  setSync({ ready: true })
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

test("mounted RuyingLogin button wires authorize, callback, dispose, and reload", async () => {
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
  current.client.global.dispose = async () => {
    calls.push("dispose")
  }
  const reload = spyOn(window.location, "reload").mockImplementation(() => calls.push("reload"))
  setSync({ ready: true })
  setSdk(current)
  const gate = mountGate()

  await settle()
  const login = [...gate.host.querySelectorAll("button")].find((button) => button.textContent?.includes("SSO 登录"))
  if (!login) throw new Error("login button not rendered")
  login.click()
  await settle()

  expect(calls).toEqual(["authorize", "callback", "dispose", "reload"])
  reload.mockRestore()
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
