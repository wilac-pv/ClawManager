import { createMemo, createSignal, Show } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"

// Bottom-left logged-in user block for the 如影 (ruying) SSO gateway. Matches
// the 如影Claw (QwenPaw console) AuthUserInfo + logout style: a compact two-line
// text block — display name on top, employee id (工号) muted below — followed by
// a 退出登录 button. The SSO user is stashed by the ruying auth plugin into
// `provider.ruying.options.ruyingUser`, synced to the web app via the provider
// list. Renders nothing until the user has logged in.
export function RuyingUser() {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const [loggingOut, setLoggingOut] = createSignal(false)

  const user = createMemo(() => {
    const provider = serverSync().data.provider.all.get("ruying")
    const raw = (provider?.options as Record<string, unknown> | undefined)?.["ruyingUser"]
    if (!raw || typeof raw !== "object") return undefined
    const value = raw as { employeeId?: unknown; displayName?: unknown }
    const displayName = typeof value.displayName === "string" ? value.displayName : ""
    const employeeId = typeof value.employeeId === "string" ? value.employeeId : ""
    if (!displayName && !employeeId) return undefined
    return { displayName, employeeId }
  })

  async function logout() {
    if (loggingOut()) return
    setLoggingOut(true)
    try {
      // Clear the login marker so the gate re-shows the SSO login. updateGlobal
      // deep-merges and can't delete a key, so overwrite ruyingUser with `false`
      // (a non-object the gate/badge both treat as "logged out"); re-login writes
      // a fresh object over it. Then dispose (awaited → server drops its cached
      // config) and hard-reload so the gate re-bootstraps logged-out.
      await serverSDK().client.global.config.update({
        config: { provider: { ruying: { options: { ruyingUser: false } } } },
      })
      await serverSDK().client.global.dispose().catch(() => {})
    } catch {
      // best-effort; reload anyway so the gate re-evaluates from disk.
    }
    window.location.reload()
  }

  return (
    <Show when={user()}>
      {(u) => {
        // display_name primary, employee_id secondary (fall back to id alone).
        const primary = () => u().displayName || u().employeeId
        const secondary = () => (u().displayName ? u().employeeId : "")
        return (
          <div class="flex flex-col gap-1">
            <div class="px-3 leading-tight">
              <div class="text-12-medium text-text-base">{primary()}</div>
              <Show when={secondary()}>
                <div class="text-11-regular text-text-weak">{secondary()}</div>
              </Show>
            </div>
            <button
              type="button"
              onClick={logout}
              disabled={loggingOut()}
              class="px-3 py-1 text-left text-11-regular text-text-weak hover:text-text-base disabled:opacity-50"
            >
              {loggingOut() ? "正在退出…" : "退出登录"}
            </button>
          </div>
        )
      }}
    </Show>
  )
}
