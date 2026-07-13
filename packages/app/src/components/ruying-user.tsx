import { createComputed, createMemo, Match, onCleanup, Show, Switch, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
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

export function ruyingIdentity(user: { employeeId: string; displayName: string; email: string }) {
  const name = user.displayName.trim()
  const employeeId = user.employeeId.trim()
  const primary = name || employeeId
  return {
    primary,
    ...(name && employeeId ? { secondary: employeeId } : {}),
    initial: Array.from(primary)[0] ?? "人",
  }
}

export function RuyingIdentityBlock(props: {
  user: { employeeId: string; displayName: string; email: string }
  loggingOut: boolean
  logoutMessage: string
  onLogout: () => void
}) {
  const identity = createMemo(() => ruyingIdentity(props.user))
  return (
    <DropdownMenu gutter={4} placement="top-end">
      <DropdownMenu.Trigger
        class="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-raised-base text-11-medium text-text-base"
        aria-label={`用户操作：${identity().primary}`}
        title={identity().primary}
      >
        <span aria-hidden="true">
          {identity().initial}
        </span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="w-56">
          <div class="min-w-0 px-2 py-1.5 leading-tight">
            <div data-slot="ruying-name" class="truncate text-12-medium text-text-base" title={identity().primary}>
              {identity().primary}
            </div>
            <Show when={identity().secondary}>
              <div data-slot="ruying-employee-id" class="mt-0.5 truncate font-mono text-11-regular text-text-weak" title={identity().secondary}>
                {identity().secondary}
              </div>
            </Show>
          </div>
          <DropdownMenu.Item disabled={props.loggingOut} onSelect={props.onLogout}>
            <DropdownMenu.ItemLabel>{props.loggingOut ? "正在退出…" : "退出登录"}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <Show when={props.logoutMessage}>
            <div class="min-w-0 px-2 py-1.5">
              <div role="alert" class="truncate text-11-regular text-text-base" title={props.logoutMessage}>
                {props.logoutMessage}
              </div>
              <button type="button" class="text-11-regular text-text-weak hover:text-text-base" onClick={props.onLogout}>
                重试退出
              </button>
            </div>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
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
        request++
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

export function RuyingUserView(props: {
  status: RuyingUserStatus
  user?: ReturnType<typeof readRuyingStatusUser>
  message: string
  loggingOut: boolean
  logoutMessage: string
  onRefresh: () => void
  onLogout: () => void
}) {
  return (
    <Switch>
      <Match when={props.status === "checking"}>
        <div
          role="status"
          class="grid size-8 shrink-0 place-items-center rounded-lg text-11-regular text-text-weak"
          aria-label="正在检查登录状态"
          title="正在检查登录状态"
        >
          <span aria-hidden="true">…</span>
        </div>
      </Match>
      <Match when={props.status === "error"}>
        <button
          type="button"
          role="button"
          class="grid size-8 shrink-0 place-items-center rounded-lg text-11-medium text-text-base hover:bg-surface-raised-base"
          aria-label={`登录状态错误：${props.message}，点击重试`}
          title={`登录状态错误：${props.message}，点击重试`}
          onClick={props.onRefresh}
        >
          <span aria-hidden="true">!</span>
        </button>
      </Match>
      <Match when={props.status === "user" && props.user}>
        <RuyingIdentityBlock
          user={props.user!}
          loggingOut={props.loggingOut}
          logoutMessage={props.logoutMessage}
          onLogout={props.onLogout}
        />
      </Match>
    </Switch>
  )
}

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
    <RuyingUserView
      status={user.state.status}
      user={user.state.user}
      message={user.state.message}
      loggingOut={user.state.loggingOut}
      logoutMessage={user.state.logoutMessage}
      onRefresh={() => void user.refresh()}
      onLogout={() => void user.logout()}
    />
  )
}
