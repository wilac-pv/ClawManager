# Ruying Code App and Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Web App 与 Electron Desktop 的外部身份统一为如影 Code，并复用同一 SSO 门禁。

**Architecture:** 保留现有 App 布局与主题，只把本地分支中的 `RuyingGate`/`RuyingUser` 提取成可测试组件。Electron 构建配置读取品牌常量的镜像值，正式图标缺失期间使用一套集中生成的占位资源。

**Tech Stack:** SolidJS, Electron, electron-builder, Bun, bun:test

## Global Constraints

- UI 只改名称、图标和登录门禁，不改颜色、主题、布局或交互结构。
- App 必须优先稳定、简单，再考虑性能。
- SolidJS 状态使用 `createStore`，不新增一组独立 `createSignal`。
- Electron Renderer 只能通过 preload 的 `window.api` 访问主进程能力。
- 生产 Bundle ID 必须为 `cn.gwm.ruying-code`。

---

### Task 1: Extract a testable App SSO gate

**Files:**
- Create: `packages/app/src/components/ruying-login.tsx`
- Create: `packages/app/src/components/ruying-login.test.tsx`
- Modify: `packages/app/src/app.tsx`

**Interfaces:**
- Produces: `RuyingGate`, `RuyingLogin`, and `readRuyingUser(options)`.

- [ ] **Step 1: Write gate state tests**

```ts
test("requires identity metadata instead of a bare api key", () => {
  expect(readRuyingUser({ apiKey: "sk-existing" })).toBeUndefined()
  expect(readRuyingUser({ ruyingUser: { employeeId: "GW001", displayName: "张三", email: "" } })).toEqual({
    employeeId: "GW001",
    displayName: "张三",
    email: "",
  })
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/app`: `bun run test:unit -- src/components/ruying-login.test.tsx`  
Expected: FAIL because the extracted module is missing.

- [ ] **Step 3: Extract the component and use one store**

```tsx
const [state, setState] = createStore({ status: "idle" as "idle" | "pending" | "error", message: "", authUrl: "" })

export function readRuyingUser(options: unknown) {
  if (!options || typeof options !== "object" || !("ruyingUser" in options)) return
  const user = (options as { ruyingUser?: unknown }).ruyingUser
  if (!user || typeof user !== "object") return
  return user as { employeeId: string; displayName: string; email: string }
}
```

Move the approved login flow from `app.tsx` unchanged in behavior and keep `NewAppLayout` wrapped by `RuyingGate`.

- [ ] **Step 4: Run tests and typecheck**

Run from `packages/app`: `bun run test:unit -- src/components/ruying-login.test.tsx && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/app.tsx packages/app/src/components/ruying-login.tsx packages/app/src/components/ruying-login.test.tsx
git commit -m "refactor(app): extract ruying login gate"
```

### Task 2: Make user identity and logout consistent

**Files:**
- Modify: `packages/app/src/components/ruying-user.tsx`
- Create: `packages/app/src/components/ruying-user.test.tsx`
- Modify: `packages/app/src/pages/layout-new.tsx`
- Modify: `packages/app/src/pages/layout.tsx`

**Interfaces:**
- Consumes: `readRuyingUser`.
- Produces: a single logout action that removes credential and identity before reload.

- [ ] **Step 1: Write logout tests**

```ts
test("does not reload when logout fails", async () => {
  const result = await logoutRuying({ remove: async () => { throw new Error("disk") }, reload: () => calls.push("reload") })
  expect(result).toEqual({ ok: false, message: "disk" })
  expect(calls).toEqual([])
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/app`: `bun run test:unit -- src/components/ruying-user.test.tsx`  
Expected: FAIL because logout currently reports best-effort success.

- [ ] **Step 3: Implement explicit success/failure**

```ts
export async function logoutRuying(input: { remove: () => Promise<void>; reload: () => void }) {
  try {
    await input.remove()
    input.reload()
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
  }
}
```

Render the existing two-line user block in both layouts and show the returned error without changing layout geometry.

- [ ] **Step 4: Run tests and typecheck**

Run from `packages/app`: `bun run test:unit -- src/components/ruying-user.test.tsx && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/ruying-user.tsx packages/app/src/components/ruying-user.test.tsx packages/app/src/pages/layout-new.tsx packages/app/src/pages/layout.tsx
git commit -m "fix(app): make ruying logout reliable"
```

### Task 3: Brand the Electron package and protocols

**Files:**
- Modify: `packages/desktop/electron-builder.config.ts`
- Modify: `packages/desktop/electron-builder.config.test.ts`
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/src/main/menu.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/constants.ts`
- Modify: `packages/desktop/src/main/migrate.ts`
- Create: `packages/desktop/src/main/migrate.test.ts`
- Modify: `packages/desktop/src/renderer/index.html`
- Modify: `packages/desktop/resources/linux/opencode-desktop.desktop`

**Interfaces:**
- Produces: prod ID `cn.gwm.ruying-code`, beta/dev suffixes, protocol `ruying-code`, product names, artifact prefix `ruying-code-desktop`.

- [ ] **Step 1: Replace builder expectations first**

```ts
const channels = [
  { channel: "dev", appId: "cn.gwm.ruying-code.dev", name: "如影 Code Dev" },
  { channel: "beta", appId: "cn.gwm.ruying-code.beta", name: "如影 Code Beta" },
  { channel: "prod", appId: "cn.gwm.ruying-code", name: "如影 Code" },
] as const

expect(config.productName).toBe(channel.name)
expect(config.artifactName).toBe("ruying-code-desktop-${os}-${arch}.${ext}")
expect(config.protocols).toEqual({ name: channel.name, schemes: ["ruying-code", "opencode"] })
```

Also assert that no OpenCode GitHub publisher remains:

```ts
process.env.RUYING_CODE_DESKTOP_UPDATE_URL = "https://updates.gwm.example/ruying-code/"
expect(config.publish).toEqual({ provider: "generic", url: process.env.RUYING_CODE_DESKTOP_UPDATE_URL })
```

- [ ] **Step 2: Verify failure**

Run from `packages/desktop`: `bun test electron-builder.config.test.ts`  
Expected: FAIL with `ai.opencode.desktop*` values.

- [ ] **Step 3: Update manifests and visible strings**

```ts
const APP_IDS = {
  dev: "cn.gwm.ruying-code.dev",
  beta: "cn.gwm.ruying-code.beta",
  prod: "cn.gwm.ruying-code",
} as const
```

Set `productName`, RPM package names, artifact names, menu/about text, HTML title, and package metadata to 如影 Code. Keep `opencode` only as a compatibility deep-link scheme and hidden legacy launcher.

Replace GitHub publishing with an optional internal generic feed and disable the updater when the feed is absent:

```ts
const updateUrl = process.env.RUYING_CODE_DESKTOP_UPDATE_URL
const publish = updateUrl ? { provider: "generic" as const, url: updateUrl } : undefined
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev" && !!import.meta.env.RUYING_CODE_DESKTOP_UPDATE_URL
```

Extend desktop migration so the new `cn.gwm.ruying-code*` user-data store imports missing keys from the matching legacy `ai.opencode.desktop*` store exactly once:

```ts
const LEGACY_APP_IDS = { dev: "ai.opencode.desktop.dev", beta: "ai.opencode.desktop.beta", prod: "ai.opencode.desktop" }
const RUYING_APP_IDS = { dev: "cn.gwm.ruying-code.dev", beta: "cn.gwm.ruying-code.beta", prod: "cn.gwm.ruying-code" }
```

Test that an existing new-store key wins and the legacy directory remains on disk.

- [ ] **Step 4: Run tests and typecheck**

Run from `packages/desktop`: `bun test electron-builder.config.test.ts && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/electron-builder.config.ts packages/desktop/electron-builder.config.test.ts packages/desktop/package.json packages/desktop/src packages/desktop/resources/linux
git commit -m "feat(desktop): brand the ruying application"
```

### Task 4: Replace desktop and App icons with a centralized placeholder

**Files:**
- Create: `packages/desktop/app-icon.png`
- Replace: `packages/desktop/icons/dev/**`
- Replace: `packages/desktop/icons/beta/**`
- Replace: `packages/desktop/icons/prod/**`
- Modify: `packages/desktop/icons/README.md`
- Modify: `packages/desktop/scripts/copy-icons.ts`
- Modify: `packages/ui/src/logo.tsx` (only the source mark; preserve sizing and colors)

**Interfaces:**
- Produces: one documented 1024×1024 placeholder source and generated platform variants.

- [ ] **Step 1: Generate the approved placeholder source**

Use the image generation skill with this exact prompt:

```text
1024x1024 square enterprise developer-tool app icon, simple Chinese character 影 centered, flat high-contrast shapes, no gradient, no text other than the single character, generous platform-safe padding, transparent outer background
```

Save the selected result as `packages/desktop/app-icon.png`.

- [ ] **Step 2: Generate platform variants**

Run from `packages/desktop`:

```bash
bun tauri icon -o icons/prod app-icon.png
bun tauri icon -o icons/beta app-icon.png
bun tauri icon -o icons/dev app-icon.png
cp icons/prod/128x128@2x.png icons/prod/dock.png
cp icons/beta/128x128@2x.png icons/beta/dock.png
cp icons/dev/128x128@2x.png icons/dev/dock.png
```

Expected: each channel contains `icon.icns`, `icon.ico`, `icon.png`, `dock.png`, Linux sizes and Windows tiles consumed by `copy-icons.ts`.

Expected: every channel contains the filenames consumed by `scripts/copy-icons.ts`.

- [ ] **Step 3: Verify the build selects only the placeholder set**

Run from `packages/desktop`: `bun scripts/copy-icons.ts prod && test -f resources/icons/icon.icns && test -f resources/icons/icon.ico && test -f resources/icons/icon.png`  
Expected: exit 0.

- [ ] **Step 4: Run desktop package smoke build**

Run from `packages/desktop`: `bun run build && bun run package --dir`  
Expected: packaged metadata uses 如影 Code and generated icons.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/app-icon.png packages/desktop/icons packages/desktop/icons/README.md packages/desktop/scripts/copy-icons.ts packages/ui/src/logo.tsx
git commit -m "feat(desktop): add ruying placeholder icons"
```
