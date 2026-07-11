import { onMount, Show } from "solid-js"
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
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
  }
}

// Bottom-left logged-in user block for the 如影 (ruying) SSO gateway. Matches
// the 如影Claw (QwenPaw console) AuthUserInfo + logout style: a compact two-line
// text block — display name on top, employee id (工号) muted below — followed by
// a 退出登录 button. Renders nothing until the authoritative Ruying session
// status returns a logged-in identity.
export function RuyingUser() {
  const serverSDK = useServerSDK()
  const [state, setState] = createStore({
    user: undefined as ReturnType<typeof readRuyingStatusUser>,
    loggingOut: false,
    message: "",
  })

  onMount(() => {
    void serverSDK()
      .client.provider.ruying.status(undefined, { throwOnError: true })
      .then((result) => setState("user", readRuyingStatusUser(result)))
      .catch(() => undefined)
  })

  async function logout() {
    if (state.loggingOut) return
    setState({ loggingOut: true, message: "" })
    const result = await logoutRuying({
      remove: () =>
        serverSDK()
          .client.provider.ruying.logout(undefined, { throwOnError: true })
          .then(() => undefined),
      reload: () => window.location.reload(),
    })
    if (result.ok) return
    setState({ loggingOut: false, message: result.message })
  }

  return (
    <Show when={state.user}>
      {(user) => (
        <div class="flex flex-col gap-1">
          <div class="px-3 leading-tight">
            <div class="text-12-medium text-text-base">{user().displayName || user().employeeId}</div>
            <Show when={user().displayName && user().employeeId}>
              <div class="text-11-regular text-text-weak">{user().employeeId}</div>
            </Show>
          </div>
          <button
            type="button"
            onClick={logout}
            disabled={state.loggingOut}
            class="px-3 py-1 text-left text-11-regular text-text-weak hover:text-text-base disabled:opacity-50"
          >
            {state.loggingOut ? "正在退出…" : "退出登录"}
          </button>
          <Show when={state.message}>
            <div role="alert" class="px-3 text-11-regular text-text-base">
              {state.message}
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
