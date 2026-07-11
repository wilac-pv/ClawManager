import { expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"

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

const { createRuyingGateController, createRuyingLoginController } = await import("./ruying-login")

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
