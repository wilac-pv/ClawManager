# 如影 Code 左下角身份区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将左下角 GWM SSO 身份区改造成头像、姓名、工号和操作菜单分层清晰的紧凑组件，并保证窄侧栏与长文本下不挤压。

**Architecture:** 保留 `createRuyingUserController` 数据流，在 `ruying-user.tsx` 内增加纯身份展示模型和独立的 `RuyingIdentityBlock` 视图边界。`RuyingUser` 继续负责状态分支，登录状态改由身份块渲染；退出操作使用现有 DropdownMenu 和 IconButton。

**Tech Stack:** TypeScript、SolidJS、Kobalte DropdownMenu、Bun test、Happy DOM、Tailwind utility classes

## Global Constraints

- 只调整 `RuyingUser` 的视觉布局、退出入口和相关状态展示。
- 不改变 SSO、身份数据结构、退出接口、侧栏宽度或其他导航组件。
- 姓名和工号保持单行；空间不足时截断，不能覆盖头像或操作按钮。
- 退出登录默认隐藏在“用户操作”菜单中。
- 测试必须从 `packages/app` 运行，类型检查使用 `bun typecheck`。

## File Structure

- Modify: `packages/app/src/components/ruying-user.tsx` — 展示模型、身份块、操作菜单和状态布局。
- Modify: `packages/app/src/components/ruying-user.test.tsx` — 展示模型与控制器回归测试。
- Create: `packages/app/src/components/ruying-user-view.test.tsx` — 挂载身份块并验证 DOM、菜单及退出状态。

---

### Task 1: 身份展示模型

**Files:**
- Modify: `packages/app/src/components/ruying-user.tsx`
- Test: `packages/app/src/components/ruying-user.test.tsx`

**Interfaces:**
- Consumes: `{ employeeId: string; displayName: string; email: string }`。
- Produces: `ruyingIdentity(user): { primary: string; secondary?: string; initial: string }`。

- [ ] **Step 1: 写入失败测试**

在 `ruying-user.test.tsx` 导入 `ruyingIdentity` 并加入：

```ts
test("derives a stable two-line Ruying identity", () => {
  expect(ruyingIdentity({ employeeId: "GW00378008", displayName: "陈奇琛", email: "" })).toEqual({
    primary: "陈奇琛",
    secondary: "GW00378008",
    initial: "陈",
  })
  expect(ruyingIdentity({ employeeId: "GW00378008", displayName: "", email: "" })).toEqual({
    primary: "GW00378008",
    initial: "G",
  })
  expect(ruyingIdentity({ employeeId: "", displayName: "", email: "" })).toEqual({
    primary: "",
    initial: "人",
  })
})
```

- [ ] **Step 2: 验证测试因缺少导出而失败**

```bash
cd packages/app
bun test --preload ./happydom.ts ./src/components/ruying-user.test.tsx --test-name-pattern "stable two-line"
```

Expected: FAIL because `ruyingIdentity` is not exported.

- [ ] **Step 3: 实现最小展示模型**

在 `readRuyingStatusUser` 后加入：

```ts
export function ruyingIdentity(user: { employeeId: string; displayName: string }) {
  const name = user.displayName.trim()
  const employeeId = user.employeeId.trim()
  const primary = name || employeeId
  return {
    primary,
    ...(name && employeeId ? { secondary: employeeId } : {}),
    initial: Array.from(primary)[0] ?? "人",
  }
}
```

- [ ] **Step 4: 运行完整控制器测试**

```bash
bun test --preload ./happydom.ts ./src/components/ruying-user.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 5: 提交**

```bash
git add packages/app/src/components/ruying-user.tsx packages/app/src/components/ruying-user.test.tsx
git commit -m "feat(app): derive ruying identity display"
```

### Task 2: 身份块、操作菜单和紧凑状态

**Files:**
- Modify: `packages/app/src/components/ruying-user.tsx`
- Create: `packages/app/src/components/ruying-user-view.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ruyingIdentity(user)`。
- Produces: `RuyingIdentityBlock(props)`，props 为 `{ user, loggingOut, logoutMessage, onLogout }`。

- [ ] **Step 1: 创建失败的挂载测试**

创建 `ruying-user-view.test.tsx`，使用 `bun:test`、`createComponent` 和 `solid-js/web` 的 `render`。在动态 import `ruying-user` 前加入以下最小 UI mock：

```tsx
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
```

先加入长姓名布局测试：

```ts
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
```

再加入以下三个完整测试：

```ts
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
})

test("disables logout and exposes retry after failure", () => {
  const host = document.createElement("div")
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
})
```

- [ ] **Step 2: 运行视图测试并确认失败**

```bash
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts ./src/components/ruying-user-view.test.tsx
```

Expected: FAIL because `RuyingIdentityBlock` does not exist.

- [ ] **Step 3: 实现身份块**

在 `ruying-user.tsx` 引入：

```ts
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
```

实现以下结构；不要抽取额外的一次性 helper：

```tsx
export function RuyingIdentityBlock(props: {
  user: { employeeId: string; displayName: string; email: string }
  loggingOut: boolean
  logoutMessage: string
  onLogout: () => void
}) {
  const identity = createMemo(() => ruyingIdentity(props.user))
  return (
    <div class="border-t border-border-weak-base px-2 pt-2 pb-1">
      <div class="flex min-w-0 items-center gap-2">
        <div aria-hidden="true" class="grid size-[30px] shrink-0 place-items-center rounded-lg bg-surface-raised-base text-11-medium text-text-base">
          {identity().initial}
        </div>
        <div class="min-w-0 flex-1 leading-tight">
          <div data-slot="ruying-name" class="truncate text-12-medium text-text-base" title={identity().primary}>
            {identity().primary}
          </div>
          <Show when={identity().secondary}>
            <div data-slot="ruying-employee-id" class="mt-0.5 truncate font-mono text-11-regular text-text-weak" title={identity().secondary}>
              {identity().secondary}
            </div>
          </Show>
        </div>
        <DropdownMenu gutter={4} placement="top-end">
          <DropdownMenu.Trigger as={IconButton} icon="dot-grid" variant="ghost" size="small" class="size-7 shrink-0 rounded-md" aria-label="用户操作" />
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <DropdownMenu.Item disabled={props.loggingOut} onSelect={props.onLogout}>
                <DropdownMenu.ItemLabel>{props.loggingOut ? "正在退出…" : "退出登录"}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </div>
      <Show when={props.logoutMessage}>
        <div class="mt-1 pl-[38px] pr-1">
          <div role="alert" class="truncate text-11-regular text-text-base" title={props.logoutMessage}>{props.logoutMessage}</div>
          <button class="text-11-regular text-text-weak hover:text-text-base" onClick={props.onLogout}>重试退出</button>
        </div>
      </Show>
    </div>
  )
}
```

- [ ] **Step 4: 接入状态分支**

把 checking 容器改为：

```tsx
<div role="status" class="flex min-h-12 items-center border-t border-border-weak-base px-3 text-11-regular text-text-weak">
  正在检查登录状态…
</div>
```

error 容器使用 `min-h-12 border-t border-border-weak-base px-3 py-2`，保留错误和重试。user 分支替换为：

```tsx
<RuyingIdentityBlock
  user={user.state.user!}
  loggingOut={user.state.loggingOut}
  logoutMessage={user.state.logoutMessage}
  onLogout={() => void user.logout()}
/>
```

- [ ] **Step 5: 运行视图、控制器和连线测试**

```bash
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts ./src/components/ruying-user-view.test.tsx ./src/components/ruying-wiring.test.tsx
bun test --preload ./happydom.ts ./src/components/ruying-user.test.tsx
```

Expected: all tests PASS with no new warnings.

- [ ] **Step 6: 运行类型和格式检查**

```bash
bun typecheck
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 7: 提交**

```bash
git add packages/app/src/components/ruying-user.tsx packages/app/src/components/ruying-user-view.test.tsx
git commit -m "feat(app): redesign ruying identity block"
```

### Task 3: 最终回归验证

**Files:**
- Verify: `packages/app/src/components/ruying-user.tsx`
- Verify: `packages/app/src/components/ruying-user.test.tsx`
- Verify: `packages/app/src/components/ruying-user-view.test.tsx`

**Interfaces:**
- Consumes: Task 1 和 Task 2 的最终组件与测试。
- Produces: 可交付的 App 变更，不新增接口。

- [ ] **Step 1: 运行完整如影 App 聚焦测试**

```bash
cd packages/app
bun test --preload ./happydom.ts ./src/components/ruying-login.test.tsx ./src/components/ruying-user.test.tsx ./src/context/server-sync.test.ts ./src/utils/web-link.test.ts
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts ./src/components/ruying-user-view.test.tsx ./src/components/ruying-wiring.test.tsx
bun test ./src/ruying-layout-gate.test.ts
```

Expected: zero failed tests.

- [ ] **Step 2: 运行最终检查**

```bash
bun typecheck
git diff --check
git status --short
```

Expected: typecheck and diff check exit 0；没有未提交的源文件或测试文件。`.superpowers/brainstorm/` 可以保留为未跟踪的本地视觉伴侣产物，但不得提交。
