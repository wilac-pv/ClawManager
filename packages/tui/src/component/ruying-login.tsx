import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, onMount, Show, type ParentProps } from "solid-js"
import { Brand } from "@opencode-ai/core/brand/brand"
import type { ProviderRuyingStatusResponse } from "@opencode-ai/sdk/v2"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { Link } from "../ui/link"
import { Logo } from "./logo"

export function RuyingLoginGate(props: ParentProps) {
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const [session, setSession] = createSignal<ProviderRuyingStatusResponse>()
  const [checking, setChecking] = createSignal(true)
  const [loginStatus, setLoginStatus] = createSignal<"idle" | "pending" | "error">("idle")
  const [loginMessage, setLoginMessage] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [canceling, setCanceling] = createSignal(false)
  const [loggingOut, setLoggingOut] = createSignal(false)
  const [logoutMessage, setLogoutMessage] = createSignal("")
  const user = createMemo(() => (session()?.loggedIn ? (session()?.user ?? {}) : undefined))
  let attempt = 0

  async function status() {
    const result = await sdk.client.provider.ruying.status()
    if (result.error || !result.data) return
    setSession(result.data)
    return result.data
  }

  onMount(() => {
    void status()
      .then((value) => {
        if (value) return
        setSession({ loggedIn: false })
        setLoginStatus("error")
        setLoginMessage("无法检查登录状态，请重试")
      })
      .catch((error) => {
        setSession({ loggedIn: false })
        setLoginStatus("error")
        setLoginMessage(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setChecking(false))
  })

  async function login(current: number) {
    setLoginStatus("pending")
    setLoginMessage("")
    setUrl("")
    const authorization = await sdk.client.provider.oauth.authorize({
      providerID: Brand.profile.providerID,
      method: 0,
    })
    if (current !== attempt) return
    if (authorization.error || !authorization.data) {
      setLoginStatus("error")
      setLoginMessage("无法启动 GWM SSO 登录，请重试")
      return
    }
    setUrl(authorization.data.url)
    const callback = await sdk.client.provider.oauth.callback({
      providerID: Brand.profile.providerID,
      method: 0,
    })
    if (current !== attempt) return
    if (callback.error) {
      setLoginStatus("error")
      setLoginMessage("登录失败，请重试；如需开通权限，请联系管理员")
      return
    }
    await sdk.client.global.dispose()
    if (current !== attempt) return
    await sync.bootstrap()
    if (current !== attempt) return
    const refreshed = await status()
    if (current !== attempt) return
    if (refreshed?.loggedIn) {
      setLoginStatus("idle")
      return
    }
    setLoginStatus("error")
    setLoginMessage("登录状态未生效，请重试")
  }

  function startLogin() {
    const current = ++attempt
    void login(current).catch((error) => {
      if (current !== attempt) return
      setLoginStatus("error")
      setLoginMessage(error instanceof Error ? error.message : String(error))
    })
  }

  async function cancelLogin(current: number) {
    const result = await sdk.client.provider.oauth.cancel({ providerID: Brand.profile.providerID })
    if (current !== attempt) return
    setCanceling(false)
    if (result.error) {
      setLoginStatus("error")
      setLoginMessage("取消登录失败，请重试")
      return
    }
    setLoginStatus("idle")
    setLoginMessage("")
    setUrl("")
  }

  function startCancel() {
    if (canceling()) return
    const current = ++attempt
    setCanceling(true)
    void cancelLogin(current).catch((error) => {
      if (current !== attempt) return
      setCanceling(false)
      setLoginStatus("error")
      setLoginMessage(error instanceof Error ? error.message : String(error))
    })
  }

  async function logout() {
    if (loggingOut()) return
    setLoggingOut(true)
    setLogoutMessage("")
    const result = await sdk.client.provider.ruying.logout()
    if (result.error) {
      setLoggingOut(false)
      setLogoutMessage("退出失败，请重试")
      return
    }
    await sync.bootstrap()
    const refreshed = await status()
    setLoggingOut(false)
    if (refreshed && !refreshed.loggedIn) {
      setLoginStatus("idle")
      return
    }
    setLogoutMessage("退出状态未生效，请重试")
  }

  function startLogout() {
    void logout().catch((error) => {
      setLoggingOut(false)
      setLogoutMessage(error instanceof Error ? error.message : String(error))
    })
  }

  useKeyboard((event) => {
    if (event.name === "escape" && loginStatus() === "pending" && !canceling()) {
      event.preventDefault()
      event.stopPropagation()
      startCancel()
      return
    }
    if (!checking() && !user() && event.name === "return" && loginStatus() !== "pending") {
      event.preventDefault()
      event.stopPropagation()
      startLogin()
      return
    }
    if (user() && event.name.toLowerCase() === "l" && event.ctrl && event.shift && !loggingOut()) {
      event.preventDefault()
      event.stopPropagation()
      startLogout()
    }
  })

  return (
    <Show when={!checking()} fallback={<RuyingChecking />}>
      <Show
        when={user()}
        fallback={
          <RuyingLogin
            status={loginStatus()}
            message={loginMessage()}
            url={url()}
            onLogin={startLogin}
            onCancel={startCancel}
          />
        }
      >
        {(identity) => (
          <>
            {props.children}
            <box position="absolute" top={0} right={1} zIndex={2000} flexDirection="column" alignItems="flex-end">
              <box flexDirection="row" gap={1}>
                <text fg={theme.textMuted}>
                  {identity().displayName || identity().employeeId}
                  <Show when={identity().displayName && identity().employeeId}> ({identity().employeeId})</Show>
                </text>
                <text
                  fg={theme.primary}
                  attributes={TextAttributes.BOLD}
                  onMouseUp={startLogout}
                  selectable={false}
                >
                  Ctrl+Shift+L {loggingOut() ? "正在退出…" : "退出登录"}
                </text>
              </box>
              <Show when={logoutMessage()}>
                <text fg={theme.error}>{logoutMessage()}</text>
              </Show>
            </box>
          </>
        )}
      </Show>
    </Show>
  )
}

function RuyingChecking() {
  const { theme } = useTheme()
  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center" backgroundColor={theme.background}>
      <text fg={theme.textMuted}>正在检查 GWM SSO 登录状态…</text>
    </box>
  )
}

function RuyingLogin(props: {
  status: "idle" | "pending" | "error"
  message: string
  url: string
  onLogin: () => void
  onCancel: () => void
}) {
  const { theme } = useTheme()
  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center" backgroundColor={theme.background}>
      <box alignItems="center" gap={1}>
        <Logo />
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          如影编码网关
        </text>
        <Show
          when={props.status === "pending"}
          fallback={
            <>
              <text fg={theme.textMuted}>请使用 GWM SSO 登录以继续使用</text>
              <text fg={theme.primary} attributes={TextAttributes.BOLD} onMouseUp={props.onLogin} selectable={false}>
                Enter&nbsp; SSO 登录
              </text>
              <Show when={props.status === "error"}>
                <text fg={theme.error}>{props.message}</text>
              </Show>
            </>
          }
        >
          <text fg={theme.textMuted}>正在等待浏览器完成 SSO 登录…</text>
          <Show when={props.url}>{(href) => <Link href={href()} fg={theme.primary} />}</Show>
          <text fg={theme.textMuted} onMouseUp={props.onCancel} selectable={false}>
            Esc 取消
          </text>
        </Show>
      </box>
    </box>
  )
}
