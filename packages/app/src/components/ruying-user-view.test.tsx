import { expect, mock, test } from "bun:test"
import { createComponent, createContext, createSignal, Show, type JSX, useContext } from "solid-js"
import { render } from "solid-js/web"

const MenuContext = createContext<{ open: () => boolean; show: () => void }>()
const passthrough = (props: { children?: JSX.Element }) => props.children
const Menu = (props: { children?: JSX.Element }) => {
  const [open, setOpen] = createSignal(false)
  return <MenuContext.Provider value={{ open, show: () => setOpen(true) }}>{props.children}</MenuContext.Provider>
}

mock.module("@opencode-ai/ui/dropdown-menu", () => ({
  DropdownMenu: Object.assign(Menu, {
    Trigger: (props: { class?: string; "aria-label"?: string }) => {
      const menu = useContext(MenuContext)
      return <button class={props.class} aria-label={props["aria-label"]} onClick={menu?.show} />
    },
    Portal: passthrough,
    Content: (props: { children?: JSX.Element; class?: string }) => {
      const menu = useContext(MenuContext)
      return <Show when={menu?.open()}><div class={props.class}>{props.children}</div></Show>
    },
    Item: (props: { children?: JSX.Element; disabled?: boolean; onSelect?: () => void }) => (
      <button disabled={props.disabled} onClick={props.onSelect}>{props.children}</button>
    ),
    ItemLabel: passthrough,
  }),
}))
mock.module("@opencode-ai/ui/icon-button", () => ({ IconButton: () => document.createElement("button") }))

const { RuyingIdentityBlock, RuyingUserView } = await import("./ruying-user")

test("keeps long identity text hidden until the fixed avatar opens the menu", () => {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() =>
    createComponent(RuyingIdentityBlock, {
      user: { employeeId: "GW00378008-VERY-LONG", displayName: "欧阳非常非常非常长的姓名", email: "" },
      loggingOut: false,
      logoutMessage: "",
      onLogout: () => undefined,
    }), host)

  const trigger = host.querySelector('button[aria-label*="用户操作"]') as HTMLButtonElement
  expect(trigger.className).toContain("size-8")
  expect(host.querySelector('[data-slot="ruying-name"]')).toBeNull()
  expect(host.querySelector('[data-slot="ruying-employee-id"]')).toBeNull()
  expect(host.textContent).not.toContain("退出登录")

  trigger.click()
  const name = host.querySelector('[data-slot="ruying-name"]')
  const employeeId = host.querySelector('[data-slot="ruying-employee-id"]')
  expect(name?.textContent).toBe("欧阳非常非常非常长的姓名")
  expect(name?.className).toContain("truncate")
  expect(employeeId?.textContent).toBe("GW00378008-VERY-LONG")
  expect(employeeId?.className).toContain("truncate")
  expect(host.textContent).toContain("退出登录")
  dispose()
  host.remove()
})

test("opens the identity menu and selects logout", () => {
  const host = document.createElement("div")
  document.body.append(host)
  let calls = 0
  const dispose = render(() =>
    createComponent(RuyingIdentityBlock, {
      user: { employeeId: "GW00378008", displayName: "陈奇琛", email: "" },
      loggingOut: false,
      logoutMessage: "",
      onLogout: () => calls++,
    }), host)

  expect(host.textContent).not.toContain("陈奇琛")
  ;(host.querySelector('button[aria-label*="用户操作"]') as HTMLButtonElement).click()
  ;(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "退出登录") as HTMLButtonElement).click()
  expect(calls).toBe(1)
  dispose()
  host.remove()
})

test("disables logout while logging out", () => {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() =>
    createComponent(RuyingIdentityBlock, {
      user: { employeeId: "GW00378008", displayName: "陈奇琛", email: "" },
      loggingOut: true,
      logoutMessage: "",
      onLogout: () => undefined,
    }), host)

  ;(host.querySelector('button[aria-label*="用户操作"]') as HTMLButtonElement).click()
  const action = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "正在退出…")
  expect(action?.disabled).toBe(true)
  dispose()
  host.remove()
})

test("shows a failed logout and retry inside the menu", () => {
  const host = document.createElement("div")
  document.body.append(host)
  let calls = 0
  const dispose = render(() =>
    createComponent(RuyingIdentityBlock, {
      user: { employeeId: "GW00378008", displayName: "陈奇琛", email: "" },
      loggingOut: false,
      logoutMessage: "disk",
      onLogout: () => calls++,
    }), host)

  expect(host.querySelector('[role="alert"]')).toBeNull()
  ;(host.querySelector('button[aria-label*="用户操作"]') as HTMLButtonElement).click()
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("disk")
  const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "重试退出") as HTMLButtonElement
  expect(retry.disabled).toBe(false)
  retry.click()
  expect(calls).toBe(1)
  dispose()
  host.remove()
})

test("renders checking as an accessible fixed rail slot", () => {
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() =>
    createComponent(RuyingUserView, {
      status: "checking",
      message: "",
      loggingOut: false,
      logoutMessage: "",
      onRefresh: () => undefined,
      onLogout: () => undefined,
    }), host)

  const status = host.querySelector('[role="status"]') as HTMLElement
  expect(status.className).toContain("size-8")
  expect(status.getAttribute("aria-label")).toContain("正在检查")
  expect(status.title).toContain("正在检查")
  dispose()
  host.remove()
})

test("renders an accessible fixed error retry button", () => {
  const host = document.createElement("div")
  document.body.append(host)
  let calls = 0
  const dispose = render(() =>
    createComponent(RuyingUserView, {
      status: "error",
      message: "网络错误",
      loggingOut: false,
      logoutMessage: "",
      onRefresh: () => calls++,
      onLogout: () => undefined,
    }), host)

  const retry = host.querySelector('button[role="button"]') as HTMLButtonElement
  expect(retry.className).toContain("size-8")
  expect(retry.getAttribute("aria-label")).toContain("错误")
  expect(retry.title).toContain("错误")
  retry.click()
  expect(calls).toBe(1)
  dispose()
  host.remove()
})
