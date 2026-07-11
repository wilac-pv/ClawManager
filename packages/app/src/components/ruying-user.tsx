import { createComputed, createMemo, Match, onCleanup, Show, Switch, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { readRuyingUser } from "./ruying-login"

type RuyingStatusResult = {
  data?: {
    loggedIn: boolean
    user?: unknown
  }
  error?: unknown
}

type RuyingUserRuntime = {
  status: () => Promise<RuyingStatusResult>
  logout: () => Promise<void>
  subscribe: (listener: (event: { type: string }) => void) => () => void
}

type RuyingUserStatus = "checking" | "error" | "loggedOut" | "user"

export function readRuyingStatusUser(result: RuyingStatusResult) {
  if (result.error || !result.data?.loggedIn) return undefined
  const user = readRuyingUser({ ruyingUser: result.data.user })
  if (!user?.displayName && !user?.employeeId) return undefined
  return user
}

export async function logoutRuying(input: { remove: () => Promise<void>; reload: () => void }) {
  try {
    await input.remove()
    input.reload()
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, message: errorMessage(error) }
  }
}

export function createRuyingUserController(input: { runtime: Accessor<RuyingUserRuntime>; reload: () => void }) {
  const [state, setState] = createStore({
    status: "checking" as RuyingUserStatus,
    user: undefined as ReturnType<typeof readRuyingStatusUser>,
    message: "",
    loggingOut: false,
    logoutMessage: "",
  })
  let request = 0
  let activeRuntime: RuyingUserRuntime | undefined
  let unsubscribe: (() => void) | undefined

  async function refresh(runtime = activeRuntime) {
    if (!runtime) return
    const current = ++request
    setState({ status: "checking", message: "" })
    try {
      const result = await runtime.status()
      if (current !== request) return
      if (result.error) throw result.error
      if (!result.data) throw new Error("无法检查 GWM SSO 登录状态，请重试。")
      if (!result.data.loggedIn) {
        setState({ status: "loggedOut", user: undefined, message: "" })
        return
      }
      const user = readRuyingStatusUser(result)
      if (!user) throw new Error("无法读取 GWM SSO 用户信息，请重试。")
      setState({ status: "user", user, message: "" })
    } catch (error) {
      if (current !== request) return
      setState({ status: "error", user: undefined, message: errorMessage(error) })
    }
  }

  async function logout() {
    if (state.loggingOut) return
    const runtime = activeRuntime
    if (!runtime) return
    request++
    setState({ loggingOut: true, logoutMessage: "" })
    const result = await logoutRuying({
      remove: async () => {
        await runtime.logout()
        if (activeRuntime !== runtime) return
        setState({ status: "loggedOut", user: undefined, message: "" })
      },
      reload: input.reload,
    })
    if (result.ok) return
    if (activeRuntime !== runtime) return
    setState({ loggingOut: false, logoutMessage: result.message })
  }

  function activate(runtime: RuyingUserRuntime) {
    request++
    unsubscribe?.()
    activeRuntime = runtime
    setState({ loggingOut: false, logoutMessage: "" })
    const stop = runtime.subscribe((event) => {
      if (event.type !== "server.connected" && event.type !== "global.disposed") return
      void refresh(runtime)
    })
    unsubscribe = stop
    void refresh(runtime)
    return () => {
      if (activeRuntime !== runtime) return
      request++
      activeRuntime = undefined
      unsubscribe = undefined
      stop()
    }
  }

  createComputed(() => {
    const deactivate = activate(input.runtime())
    onCleanup(deactivate)
  })

  return { state, refresh, logout, activate }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

// Compact two-line GWM SSO identity and logout block shared by both App layouts.
export function RuyingUser() {
  const serverSDK = useServerSDK()
  const runtime = createMemo<RuyingUserRuntime>(() => {
    const sdk = serverSDK()
    return {
      status: () => sdk.client.provider.ruying.status(undefined, { throwOnError: true }),
      logout: () =>
        sdk.client.provider.ruying.logout(undefined, { throwOnError: true }).then(() => undefined),
      subscribe: (listener) => sdk.event.on("global", (event) => listener(event)),
    }
  })
  const user = createRuyingUserController({ runtime, reload: () => window.location.reload() })

  return (
    <Switch>
      <Match when={user.state.status === "checking"}>
        <div role="status" class="px-3 py-1 text-11-regular text-text-weak">
          正在检查登录状态…
        </div>
      </Match>
      <Match when={user.state.status === "error"}>
        <div class="flex flex-col gap-1 px-3 py-1">
          <div role="alert" class="text-11-regular text-text-base">
            {user.state.message}
          </div>
          <button
            type="button"
            class="text-left text-11-regular text-text-weak hover:text-text-base"
            onClick={() => void user.refresh()}
          >
            重试
          </button>
        </div>
      </Match>
      <Match when={user.state.status === "user" && user.state.user}>
        <div class="flex flex-col gap-1">
          <div class="px-3 leading-tight">
            <div class="text-12-medium text-text-base">
              {user.state.user?.displayName || user.state.user?.employeeId}
            </div>
            <Show when={user.state.user?.displayName && user.state.user?.employeeId}>
              <div class="text-11-regular text-text-weak">{user.state.user?.employeeId}</div>
            </Show>
          </div>
          <button
            type="button"
            onClick={user.logout}
            disabled={user.state.loggingOut}
            class="px-3 py-1 text-left text-11-regular text-text-weak hover:text-text-base disabled:opacity-50"
          >
            {user.state.loggingOut ? "正在退出…" : "退出登录"}
          </button>
          <Show when={user.state.logoutMessage}>
            <div role="alert" class="px-3 text-11-regular text-text-base">
              {user.state.logoutMessage}
            </div>
          </Show>
        </div>
      </Match>
    </Switch>
  )
}
