import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import open from "open"
import { createMemo, createSignal, Show, type ParentProps } from "solid-js"
import { Brand } from "@opencode-ai/core/brand/brand"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { Link } from "../ui/link"
import { Logo } from "./logo"

export function isRuyingLoggedIn(options: unknown) {
  if (!options || typeof options !== "object") return false
  const user = (options as { ruyingUser?: unknown }).ruyingUser
  return !!user && typeof user === "object"
}

export function RuyingLoginGate(props: ParentProps) {
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const provider = createMemo(() => sync.data.provider_next.all.find((item) => item.id === Brand.profile.providerID))
  const user = createMemo(() => {
    const options = provider()?.options
    if (!isRuyingLoggedIn(options)) return
    const value = (options as { ruyingUser: { employeeId?: unknown; displayName?: unknown } }).ruyingUser
    const employeeId = typeof value.employeeId === "string" ? value.employeeId : ""
    const displayName = typeof value.displayName === "string" ? value.displayName : ""
    return { employeeId, displayName }
  })
  const [loggingOut, setLoggingOut] = createSignal(false)

  async function logout() {
    if (loggingOut()) return
    setLoggingOut(true)
    await sdk.client.auth.remove({ providerID: Brand.profile.providerID })
    await sdk.client.global.config.update({
      config: { provider: { [Brand.profile.providerID]: { options: { ruyingUser: false } } } },
    })
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    setLoggingOut(false)
  }

  return (
    <Show when={user()} fallback={<RuyingLogin />}>
      {(identity) => (
        <>
          {props.children}
          <box position="absolute" top={0} right={1} zIndex={2000} flexDirection="row" gap={1}>
            <text fg={theme.textMuted}>
              {identity().displayName || identity().employeeId}
              <Show when={identity().displayName && identity().employeeId}> ({identity().employeeId})</Show>
            </text>
            <text
              fg={theme.primary}
              attributes={TextAttributes.BOLD}
              onMouseUp={() => void logout().catch(() => setLoggingOut(false))}
              selectable={false}
            >
              {loggingOut() ? "正在退出…" : "退出登录"}
            </text>
          </box>
        </>
      )}
    </Show>
  )
}

function RuyingLogin() {
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const [status, setStatus] = createSignal<"idle" | "pending" | "error">("idle")
  const [message, setMessage] = createSignal("")
  const [url, setUrl] = createSignal("")

  async function login() {
    if (status() === "pending") return
    setStatus("pending")
    setMessage("")
    setUrl("")
    const authorization = await sdk.client.provider.oauth.authorize({
      providerID: Brand.profile.providerID,
      method: 0,
    })
    if (authorization.error || !authorization.data) {
      setStatus("error")
      setMessage("无法启动 GWM SSO 登录，请重试")
      return
    }
    setUrl(authorization.data.url)
    void open(authorization.data.url).catch(() => undefined)
    const result = await sdk.client.provider.oauth.callback({
      providerID: Brand.profile.providerID,
      method: 0,
    })
    if (result.error) {
      setStatus("error")
      setMessage("登录失败，请重试；如需开通权限，请联系管理员")
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
  }

  useKeyboard((event) => {
    if (event.name !== "return" || status() === "pending") return
    event.preventDefault()
    event.stopPropagation()
    startLogin()
  })

  function startLogin() {
    void login().catch((error) => {
      setStatus("error")
      setMessage(error instanceof Error ? error.message : String(error))
    })
  }

  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center" backgroundColor={theme.background}>
      <box alignItems="center" gap={1}>
        <Logo />
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          如影编码网关
        </text>
        <Show
          when={status() === "pending"}
          fallback={
            <>
              <text fg={theme.textMuted}>请使用 GWM SSO 登录以继续使用</text>
              <text fg={theme.primary} attributes={TextAttributes.BOLD} onMouseUp={startLogin} selectable={false}>
                Enter&nbsp; SSO 登录
              </text>
              <Show when={status() === "error"}>
                <text fg={theme.error}>{message()}</text>
              </Show>
            </>
          }
        >
          <text fg={theme.textMuted}>正在等待浏览器完成 SSO 登录…</text>
          <Show when={url()}>{(href) => <Link href={href()} fg={theme.primary} />}</Show>
        </Show>
      </box>
    </box>
  )
}
