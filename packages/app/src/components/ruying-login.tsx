import { Button } from "@opencode-ai/ui/button"
import { Splash } from "@opencode-ai/ui/logo"
import { createEffect, onCleanup, type ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"

const RUYING_PROVIDER_ID = "ruying"

type RuyingUser = { employeeId: string; displayName: string; email: string }
type GateStatus = "checking" | "error" | "loggedOut" | "loggedIn"
type LoginStatus = "idle" | "pending" | "refreshing" | "canceling" | "error"

export function readRuyingUser(options: unknown): RuyingUser | undefined {
  if (!options || typeof options !== "object" || !("ruyingUser" in options)) return undefined
  const user = (options as { ruyingUser?: unknown }).ruyingUser
  if (!user || typeof user !== "object") return undefined
  return {
    employeeId: "employeeId" in user && typeof user.employeeId === "string" ? user.employeeId : "",
    displayName: "displayName" in user && typeof user.displayName === "string" ? user.displayName : "",
    email: "email" in user && typeof user.email === "string" ? user.email : "",
  }
}

export function createRuyingGateState(
  status: () => Promise<{ data?: { loggedIn: boolean }; error?: unknown }>,
) {
  const [state, setState] = createStore({ status: "checking" as GateStatus, message: "" })
  let request = 0
  let active:
    | {
        status: () => Promise<{ data?: { loggedIn: boolean }; error?: unknown }>
        subscribe: (listener: (event: { type: string }) => void) => () => void
      }
    | undefined
  let unsubscribe: (() => void) | undefined
  let finalizing: typeof active

  async function check(next = active?.status ?? status) {
    const current = ++request
    setState({ status: "checking", message: "" })
    try {
      const result = await next()
      if (current !== request) return
      if (result.error || !result.data) {
        setState({ status: "error", message: "无法检查 GWM SSO 登录状态，请重试。" })
        return
      }
      setState("status", result.data.loggedIn ? "loggedIn" : "loggedOut")
    } catch {
      if (current !== request) return
      setState({ status: "error", message: "无法检查 GWM SSO 登录状态，请重试。" })
    }
  }

  function retry() {
    void check()
  }

  function activate(runtime: NonNullable<typeof active>) {
    request++
    unsubscribe?.()
    active = runtime
    finalizing = undefined
    const stop = runtime.subscribe((event) => {
      if (event.type !== "server.connected" && event.type !== "global.disposed") return
      if (finalizing === runtime) return
      void check(runtime.status)
    })
    unsubscribe = stop
    void check(runtime.status)
    return () => {
      if (active !== runtime) return
      request++
      active = undefined
      finalizing = undefined
      unsubscribe = undefined
      stop()
    }
  }

  function createLoginHandoff() {
    const runtime = active
    return {
      committed: () => {
        if (!runtime || active !== runtime) return
        request++
        finalizing = runtime
        setState({ status: "loggedOut", message: "" })
      },
      failed: () => {
        if (!runtime || active !== runtime || finalizing !== runtime) return
        request++
        setState({ status: "loggedOut", message: "" })
      },
      authenticated: () => {
        if (!runtime || active !== runtime || finalizing !== runtime) return
        request++
        finalizing = undefined
        setState({ status: "loggedIn", message: "" })
      },
    }
  }

  return { state, check, retry, activate, createLoginHandoff }
}

export function createRuyingLoginState(input: {
  authorize: () => Promise<{ data?: { url?: string }; error?: unknown }>
  openLink: (url: string) => void
  reserveLink?: () => { navigate: (url: string) => void; close: () => void } | undefined
  callback: () => Promise<{ data?: boolean; error?: unknown }>
  cancel: () => Promise<{ data?: boolean; error?: unknown }>
  dispose: () => Promise<unknown>
  bootstrap: () => Promise<unknown>
  status: () => Promise<{ data?: { loggedIn: boolean }; error?: unknown }>
  committed?: () => void
  failed?: () => void
  authenticated?: () => void
}) {
  const [state, setState] = createStore({
    status: "idle" as LoginStatus,
    message: "",
    authUrl: "",
  })
  let attempt = 0
  let committed = 0
  let reservation: ReturnType<NonNullable<typeof input.reserveLink>>

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
    committed = 0
    reservation?.close()
    reservation = undefined
    setState({ status: "pending", message: "", authUrl: "" })
    const reservable = !!input.reserveLink
    const reserved = (() => {
      try {
        return input.reserveLink?.()
      } catch {
        return undefined
      }
    })()
    reservation = reserved
    let phase: "authorize" | "callback" | "refresh" = "authorize"
    try {
      const authorized = await input.authorize()
      if (current !== attempt) {
        reserved?.close()
        return
      }
      if (authorized.error || !authorized.data?.url) {
        reserved?.close()
        if (reservation === reserved) reservation = undefined
        setState({ status: "error", message: "无法启动 GWM SSO 登录，请重试。", authUrl: "" })
        return
      }
      setState({
        status: "pending",
        message: reservable && !reserved ? "浏览器阻止了新标签页，请点击或复制下方链接继续登录。" : "",
        authUrl: authorized.data.url,
      })
      if (reserved) {
        try {
          reserved.navigate(authorized.data.url)
        } catch {
          setState("message", "未能自动打开浏览器，请点击或复制下方链接继续登录。")
        }
      }
      phase = "callback"
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
      committed = current
      setState("status", "refreshing")
      input.committed?.()
      phase = "refresh"
      await input.dispose()
      if (current !== attempt) return
      await input.bootstrap()
      if (current !== attempt) return
      const refreshed = await input.status()
      if (current !== attempt) return
      if (refreshed.error || !refreshed.data?.loggedIn) {
        committed = 0
        input.failed?.()
        setState({ status: "error", message: "登录状态未生效，请重试。", authUrl: authorized.data.url })
        return
      }
      input.authenticated?.()
      setState({ status: "idle", message: "", authUrl: "" })
      if (reservation === reserved) reservation = undefined
      committed = 0
    } catch {
      if (current !== attempt) return
      if (phase === "refresh") {
        committed = 0
        input.failed?.()
      }
      setState({
        status: "error",
        message:
          phase === "authorize"
            ? "无法启动 GWM SSO 登录，请重试。"
            : phase === "callback"
              ? "登录失败，请重试。"
              : "无法刷新登录状态，请重试。",
        authUrl: state.authUrl,
      })
    }
  }

  async function cancel() {
    if (state.status !== "pending") return
    const current = ++attempt
    setState("status", "canceling")
    reservation?.close()
    reservation = undefined
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

  function invalidate() {
    if (committed === attempt) return
    attempt++
    reservation?.close()
    reservation = undefined
    setState({ status: "idle", message: "", authUrl: "" })
  }

  return { state, login, cancel, open, invalidate }
}

type LoginHandoff = {
  committed: () => void
  failed: () => void
  authenticated: () => void
}

export function RuyingLogin(props: { handoff?: LoginHandoff }) {
  const login = createRuyingLoginController(props.handoff)

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6 select-none">
      <div class="flex flex-col items-center max-w-md text-center gap-4">
        <Splash class="w-12 h-15" />
        <div class="text-16-medium text-text-strong">如影编码网关</div>
        <Show
          when={
            login.state.status === "pending" ||
            login.state.status === "refreshing" ||
            login.state.status === "canceling"
          }
          fallback={
            <>
              <p class="text-14-regular text-text-weak">请使用 GWM SSO 登录以继续使用</p>
              <Button variant="primary" size="large" onClick={login.login}>
                SSO 登录
              </Button>
              <Show when={login.state.status === "error" && login.state.message}>
                <p class="text-12-regular text-text-base">{login.state.message}</p>
              </Show>
            </>
          }
        >
          <Splash class="w-8 h-10 opacity-50 animate-pulse" />
          <p class="text-14-regular text-text-base">
            {login.state.status === "refreshing" ? "正在完成登录…" : "正在等待浏览器完成 SSO 登录…"}
          </p>
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
          <Show when={login.state.status !== "refreshing"}>
            <Button
              variant="secondary"
              size="large"
              disabled={login.state.status === "canceling"}
              onClick={login.cancel}
            >
              {login.state.status === "canceling" ? "正在取消…" : "取消登录"}
            </Button>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export function createRuyingLoginController(handoff?: LoginHandoff) {
  const serverSDK = useServerSDK()()
  const serverSync = useServerSync()()
  const platform = usePlatform()
  const login = createRuyingLoginState({
    authorize: () =>
      serverSDK.client.provider.oauth.authorize(
        { providerID: RUYING_PROVIDER_ID, method: 0 },
        { throwOnError: true },
      ),
    openLink: (url) => platform.openLink(url),
    reserveLink: platform.reserveLink,
    callback: () => serverSDK.client.provider.oauth.callback({ providerID: RUYING_PROVIDER_ID, method: 0 }),
    cancel: () => serverSDK.client.provider.oauth.cancel({ providerID: RUYING_PROVIDER_ID }),
    dispose: () => serverSDK.client.global.dispose(),
    bootstrap: () => serverSync.bootstrap(),
    status: () => serverSDK.client.provider.ruying.status(),
    committed: handoff?.committed,
    failed: handoff?.failed,
    authenticated: handoff?.authenticated,
  })
  onCleanup(login.invalidate)
  return login
}

export function RuyingGate(props: ParentProps) {
  const { gate, ready } = createRuyingGateController()

  return (
    <Show
      when={ready() && gate.state.status !== "checking"}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
          <p class="mt-4 text-14-regular text-text-base">正在检查 GWM SSO 登录状态…</p>
        </div>
      }
    >
      <Show
        when={gate.state.status !== "error"}
        fallback={
          <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-4 p-6">
            <Splash class="w-12 h-15" />
            <p class="text-14-regular text-text-base">{gate.state.message}</p>
            <Button variant="primary" size="large" onClick={gate.retry}>
              重试检查登录状态
            </Button>
          </div>
        }
      >
        <Show
          when={gate.state.status === "loggedIn"}
          fallback={<RuyingLogin handoff={gate.createLoginHandoff()} />}
        >
          {props.children}
        </Show>
      </Show>
    </Show>
  )
}

export function createRuyingGateController() {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const gate = createRuyingGateState(() => serverSDK().client.provider.ruying.status())

  createEffect(() => {
    if (!serverSync().ready) return
    const sdk = serverSDK()
    const deactivate = gate.activate({
      status: () => sdk.client.provider.ruying.status(),
      subscribe: (listener) => sdk.event.on("global", (event) => listener(event)),
    })
    onCleanup(deactivate)
  })
  return { gate, ready: () => serverSync().ready }
}
