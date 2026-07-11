import { Button } from "@opencode-ai/ui/button"
import { Splash } from "@opencode-ai/ui/logo"
import { createEffect, onCleanup, type ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"

const RUYING_PROVIDER_ID = "ruying"

type RuyingUser = { employeeId: string; displayName: string; email: string }
type GateStatus = "checking" | "error" | "loggedOut" | "loggedIn"
type LoginStatus = "idle" | "pending" | "error"

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
    } catch (error) {
      if (current !== request) return
      setState({
        status: "error",
        message: error instanceof Error ? `${error.message}，请重试。` : "无法检查 GWM SSO 登录状态，请重试。",
      })
    }
  }

  function activate(runtime: NonNullable<typeof active>) {
    request++
    unsubscribe?.()
    active = runtime
    const stop = runtime.subscribe((event) => {
      if (event.type !== "server.connected" && event.type !== "global.disposed") return
      void check(runtime.status)
    })
    unsubscribe = stop
    void check(runtime.status)
    return () => {
      if (active !== runtime) return
      request++
      active = undefined
      unsubscribe = undefined
      stop()
    }
  }

  return { state, check, activate }
}

export function createRuyingLoginState(input: {
  authorize: () => Promise<{ data?: { url?: string }; error?: unknown }>
  callback: () => Promise<{ data?: boolean; error?: unknown }>
  dispose: () => Promise<unknown>
  reload: () => unknown
}) {
  const [state, setState] = createStore({
    status: "idle" as LoginStatus,
    message: "",
    authUrl: "",
  })

  async function login() {
    setState({ status: "pending", message: "", authUrl: "" })
    try {
      const authorized = await input.authorize()
      if (authorized.error) throw new Error("无法启动 GWM SSO 登录，请重试。")
      if (authorized.data?.url) setState("authUrl", authorized.data.url)
      const result = await input.callback()
      if (result.error) {
        setState({
          status: "error",
          message: "登录失败，请重试。若提示待管理员开通，请联系管理员开通后再登录。",
        })
        return
      }
      // Success. The callback persisted the credential and identity. Dispose the
      // server's cached config, then reload so the gate performs a fresh
      // authoritative session check before showing the app.
      await input.dispose()
      input.reload()
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  return { state, login }
}

export function RuyingLogin() {
  const serverSDK = useServerSDK()
  const login = createRuyingLoginState({
    authorize: () =>
      serverSDK().client.provider.oauth.authorize(
        { providerID: RUYING_PROVIDER_ID, method: 0 },
        { throwOnError: true },
      ),
    callback: () => serverSDK().client.provider.oauth.callback({ providerID: RUYING_PROVIDER_ID, method: 0 }),
    dispose: () => serverSDK().client.global.dispose().catch(() => undefined),
    reload: () => window.location.reload(),
  })

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6 select-none">
      <div class="flex flex-col items-center max-w-md text-center gap-4">
        <Splash class="w-12 h-15" />
        <div class="text-16-medium text-text-strong">如影编码网关</div>
        <Show
          when={login.state.status === "pending"}
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
          <p class="text-14-regular text-text-base">正在等待浏览器完成 SSO 登录…</p>
          <Show when={login.state.authUrl}>
            <a
              href={login.state.authUrl}
              target="_blank"
              rel="noreferrer"
              class="text-12-regular text-text-weak underline break-all"
            >
              {login.state.authUrl}
            </a>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export function RuyingGate(props: ParentProps) {
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

  return (
    <Show
      when={serverSync().ready && gate.state.status !== "checking"}
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
            <Button variant="primary" size="large" onClick={gate.check}>
              重试检查登录状态
            </Button>
          </div>
        }
      >
        <Show when={gate.state.status === "loggedIn"} fallback={<RuyingLogin />}>
          {props.children}
        </Show>
      </Show>
    </Show>
  )
}
