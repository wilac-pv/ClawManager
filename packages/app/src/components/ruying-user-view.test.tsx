import { expect, mock, test } from "bun:test"
import { createComponent, type JSX } from "solid-js"
import { render } from "solid-js/web"

const passthrough = (props: { children?: JSX.Element }) => props.children
mock.module("@opencode-ai/ui/dropdown-menu", () => ({
  DropdownMenu: Object.assign(passthrough, {
    Trigger: (props: { class?: string; "aria-label"?: string }) => (
      <button class={props.class} aria-label={props["aria-label"]} />
    ),
    Portal: passthrough,
    Content: passthrough,
    Item: (props: { children?: JSX.Element; disabled?: boolean; onSelect?: () => void }) => (
      <button disabled={props.disabled} onClick={props.onSelect}>{props.children}</button>
    ),
    ItemLabel: passthrough,
  }),
}))
mock.module("@opencode-ai/ui/icon-button", () => ({ IconButton: () => document.createElement("button") }))

const { RuyingIdentityBlock } = await import("./ruying-user")

test("renders separated identity lines and a fixed action", () => {
  const host = document.createElement("div")
  const dispose = render(
    () =>
      createComponent(RuyingIdentityBlock, {
        user: { employeeId: "GW00378008", displayName: "欧阳非常长的姓名", email: "" },
        loggingOut: false,
        logoutMessage: "",
        onLogout: () => undefined,
      }),
    host,
  )
  const name = host.querySelector('[data-slot="ruying-name"]')
  const employeeId = host.querySelector('[data-slot="ruying-employee-id"]')
  const action = host.querySelector('button[aria-label="用户操作"]')
  expect(name?.textContent).toBe("欧阳非常长的姓名")
  expect(name?.className).toContain("truncate")
  expect(employeeId?.textContent).toBe("GW00378008")
  expect(employeeId?.className).toContain("truncate")
  expect(action?.className).toContain("shrink-0")
  dispose()
})

test("shows only one identity line when the name is missing", () => {
  const host = document.createElement("div")
  const dispose = render(() =>
    createComponent(RuyingIdentityBlock, {
      user: { employeeId: "GW00378008", displayName: "", email: "" },
      loggingOut: false,
      logoutMessage: "",
      onLogout: () => undefined,
    }), host)
  expect(host.querySelector('[data-slot="ruying-name"]')?.textContent).toBe("GW00378008")
  expect(host.querySelector('[data-slot="ruying-employee-id"]')).toBeNull()
  dispose()
})

test("keeps logout inside the accessible action menu", () => {
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
  ;(host.querySelector('button[aria-label="用户操作"]') as HTMLButtonElement).click()
  ;(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "退出登录") as HTMLButtonElement).click()
  expect(calls).toBe(1)
  dispose()
  host.remove()
})

test("disables logout and exposes retry after failure", () => {
  const host = document.createElement("div")
  document.body.append(host)
  let calls = 0
  const dispose = render(() =>
    createComponent(RuyingIdentityBlock, {
      user: { employeeId: "GW00378008", displayName: "陈奇琛", email: "" },
      loggingOut: true,
      logoutMessage: "disk",
      onLogout: () => calls++,
    }), host)
  const loggingOut = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "正在退出…")
  expect(loggingOut?.disabled).toBe(true)
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("disk")
  ;(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "重试退出") as HTMLButtonElement).click()
  expect(calls).toBe(1)
  dispose()
  host.remove()
})
