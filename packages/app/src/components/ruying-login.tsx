import { Button } from "@opencode-ai/ui/button"
import { Splash } from "@opencode-ai/ui/logo"
import { createMemo, createResource, type ParentProps, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"

const RUYING_PROVIDER_ID = "ruying"

type RuyingUser = { employeeId: string; displayName: string; email: string }

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

export function RuyingLogin() {
  const serverSDK = useServerSDK()
  const [state, setState] = createStore({
    status: "idle" as "idle" | "pending" | "error",
    message: "",
    authUrl: "",
  })

  async function login() {
    setState({ status: "pending", message: "", authUrl: "" })
    try {
      const authorized = await serverSDK().client.provider.oauth.authorize(
        { providerID: RUYING_PROVIDER_ID, method: 0 },
        { throwOnError: true },
      )
      if (authorized.data?.url) setState("authUrl", authorized.data.url)
      const result = await serverSDK().client.provider.oauth.callback({ providerID: RUYING_PROVIDER_ID, method: 0 })
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
      await serverSDK().client.global.dispose().catch(() => {})
      window.location.reload()
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6 select-none">
      <div class="flex flex-col items-center max-w-md text-center gap-4">
        <Splash class="w-12 h-15" />
        <div class="text-16-medium text-text-strong">如影编码网关</div>
        <Show
          when={state.status === "pending"}
          fallback={
            <>
              <p class="text-14-regular text-text-weak">请使用 GWM SSO 登录以继续使用</p>
              <Button variant="primary" size="large" onClick={login}>
                SSO 登录
              </Button>
              <Show when={state.status === "error" && state.message}>
                <p class="text-12-regular text-text-base">{state.message}</p>
              </Show>
            </>
          }
        >
          <Splash class="w-8 h-10 opacity-50 animate-pulse" />
          <p class="text-14-regular text-text-base">正在等待浏览器完成 SSO 登录…</p>
          <Show when={state.authUrl}>
            <a
              href={state.authUrl}
              target="_blank"
              rel="noreferrer"
              class="text-12-regular text-text-weak underline break-all"
            >
              {state.authUrl}
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
  const [loggedIn] = createResource(
    () => serverSync().ready || undefined,
    async () => {
      const result = await serverSDK().client.provider.ruying.status().catch(() => undefined)
      return result?.data?.loggedIn ?? false
    },
  )
  const checking = createMemo(() => !serverSync().ready || loggedIn.loading)

  return (
    <Show
      when={!checking()}
      fallback={
        <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      <Show when={loggedIn()} fallback={<RuyingLogin />}>
        {props.children}
      </Show>
    </Show>
  )
}
