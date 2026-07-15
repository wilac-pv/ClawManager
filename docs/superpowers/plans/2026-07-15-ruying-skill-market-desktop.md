# Ruying Skill Market Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将共享 Skill 市场接入如影 Code 桌面端，提供侧边栏入口、全屏浏览、安装状态、风险确认、更新、卸载和离线管理体验。

**Architecture:** App 通过生成的本地 SDK 实现 `SkillMarketDataSource` 与 desktop actions，复用 Web 计划创建的列表/详情组件；路由位于现有 App Router，旧布局在侧边栏“设置”上方增加入口，新布局在标题栏和命令面板增加等价入口。所有本地写入仍发生在 Sidecar 的 Server/Core，renderer 不使用 Node 文件系统或新增 Electron IPC。

**Tech Stack:** SolidJS、生成的 `@opencode-ai/sdk` 客户端、TanStack Solid Query、现有 App Router/Dialog/Toast、Bun test、Playwright。

## Global Constraints

- 功能只存在于 `ruying-code-oem`，由 `VITE_RUYING_SKILL_MARKET_ENABLED` 总开关控制；值为 `false` 时不注册入口和路由。
- 标准旧布局入口固定在侧边栏“设置”上方；市场是全屏路由，不是设置弹窗、抽屉、iframe 或外部网页。
- 新布局没有项目侧边栏，因此在标题栏右侧和命令面板提供 `Skills` 入口，进入同一个全屏路由。
- 市场内容区固定浅色；如影 Code 标题栏和窗口控件保留宿主样式。
- Renderer 只能通过生成 SDK 调用本地 Sidecar；不得 import Core/Server、读取文件系统或直接下载/解压 ZIP。
- 安装、升级和卸载成功后立即失效 installed/list/detail/updates 查询；不重启应用。
- 风险 Skill 必须先显示风险来源/报告，再勾选明确确认并点击第二次确认按钮。
- 卸载始终二次确认；下架 Skill 不自动删除。
- 网络断开时“已安装”可打开、卸载和重试刷新；远程列表显示可重试错误。
- 所有 locale 必须保持 i18n key parity；中文简体使用正式中文文案，其余语言首版至少有非空可理解文案。
- 不显示收藏、评论、发布、SkillHub 登录或 API Key 代管入口。
- App 测试/typecheck 从 `packages/app` 运行；桌面 E2E 从 `packages/desktop` 运行，禁止重启现有开发服务器。

---

## File Structure

- `packages/app/src/skill-market/desktop-source.ts`：生成 SDK 到共享数据源/动作的单一适配边界。
- `packages/app/src/skill-market/desktop-provider.tsx`：安装状态查询、mutations 和缓存失效。
- `packages/app/src/skill-market/desktop-actions.tsx`：安装/更新/卸载/刷新按钮及确认对话框。
- `packages/app/src/pages/skill-market.tsx`：桌面全屏列表/详情路由页。
- `packages/app/src/app.tsx`：`/skills` 与 `/skills/:source/:id` 路由。
- `packages/app/src/pages/layout/sidebar-shell.tsx`、`layout.tsx`：旧布局侧边栏入口。
- `packages/app/src/components/titlebar.tsx`、`pages/layout-new.tsx`：新布局入口。
- `packages/app/src/i18n/*.ts`：市场文案。
- `packages/app/e2e/skill-market.spec.ts`：桌面浏览和管理验收。

### Task 1: Adapt the generated local client to shared market interfaces

**Files:**
- Create: `packages/app/src/skill-market/desktop-source.ts`
- Create: `packages/app/src/skill-market/desktop-source.test.ts`
- Modify: `packages/app/src/skill-market/index.ts`

**Interfaces:**
- Consumes: generated `client.skillMarket` operations from the installer plan and `SkillMarketDataSource`/`SkillMarketActions` from the Web plan.
- Produces: `createDesktopSkillMarket(client): { source: SkillMarketDataSource; actions: SkillMarketActions }`.

- [ ] **Step 1: Write adapter contract tests**

```ts
test("maps every shared operation to the generated local client", async () => {
  const calls: string[] = []
  const client = fakeGeneratedClient(calls)
  const market = createDesktopSkillMarket(client)
  await market.source.list({ sort: "score", page: 1, limit: 30 })
  await market.source.facets()
  await market.source.detail({ source: "skillhub", id: "code-review" })
  await market.source.versions({ source: "skillhub", id: "code-review" })
  await market.source.installed?.()
  await market.source.updates?.()
  if (market.actions.kind !== "desktop") throw new Error("expected desktop actions")
  await market.actions.install(sampleRequest())
  await market.actions.update(sampleRequest({ version: "2.0.0" }))
  await market.actions.uninstall({ source: "skillhub", id: "code-review" })
  await market.actions.refresh({ source: "skillhub", id: "code-review" })
  expect(calls).toEqual(["list", "facets", "detail", "detail", "installed", "updates", "install", "update", "uninstall", "refresh"])
})

test("preserves stable local error codes", async () => {
  const market = createDesktopSkillMarket(failingClient({ code: "risk-confirmation-required", message: "需要确认风险" }))
  if (market.actions.kind !== "desktop") throw new Error("expected desktop actions")
  await expect(market.actions.install(sampleRequest())).rejects.toEqual(expect.objectContaining({ code: "risk-confirmation-required" }))
})
```

- [ ] **Step 2: Verify tests fail before adapter exists**

Run: `cd packages/app && bun run test:unit -- src/skill-market/desktop-source.test.ts`

Expected: FAIL because `desktop-source.ts` does not exist.

- [ ] **Step 3: Implement a thin generated-client adapter**

```ts
export function createDesktopSkillMarket(client: ServerClient) {
  const data = <A>(request: Promise<{ data?: A; error?: unknown }>) =>
    request.then((result) => {
      if (result.error) throw MarketLocalError.from(result.error)
      if (result.data === undefined) throw new MarketLocalError("market-unavailable", "市场返回空响应")
      return result.data
    })

  return {
    source: {
      list: (query, signal) => data(client.skillMarket.list({ query: {
        ...query,
        requiresApiKey: query.requiresApiKey === undefined ? undefined : String(query.requiresApiKey) as "true" | "false",
        featured: query.featured === undefined ? undefined : String(query.featured) as "true" | "false",
        enterprise: query.enterprise === undefined ? undefined : String(query.enterprise) as "true" | "false",
      } }, { signal })),
      facets: (signal) => data(client.skillMarket.facets(undefined, { signal })),
      detail: (key, signal) => data(client.skillMarket.detail({ path: key }, { signal })),
      versions: (key, signal) => data(client.skillMarket.detail({ path: key }, { signal })).then((detail) => detail.versions),
      installed: (signal) => data(client.skillMarket.installed(undefined, { signal })),
      updates: (signal) => data(client.skillMarket.updates(undefined, { signal })),
    } satisfies SkillMarketDataSource,
    actions: {
      kind: "desktop",
      install: (body) => data(client.skillMarket.install({ body })),
      update: (body) => data(client.skillMarket.update({ body })),
      uninstall: (key) => data(client.skillMarket.uninstall({ path: key })).then(() => undefined),
      refresh: (key) => data(client.skillMarket.refresh({ path: key })).then(() => undefined),
    } satisfies SkillMarketActions,
  }
}
```

Adjust argument property names to the generated client exactly; keep all SDK-specific shapes inside this file. Add `MarketLocalError` with the protocol code union and user-safe message.

- [ ] **Step 4: Run adapter tests and App typecheck**

Run: `cd packages/app && bun run test:unit -- src/skill-market/desktop-source.test.ts && bun typecheck`

Expected: adapter tests pass and App typechecks.

- [ ] **Step 5: Commit the Desktop adapter**

```bash
git add packages/app/src/skill-market/desktop-source.ts packages/app/src/skill-market/desktop-source.test.ts packages/app/src/skill-market/index.ts
git commit -m "feat(app): connect desktop skill market api"
```

### Task 2: Add installation state and confirmation actions

**Files:**
- Create: `packages/app/src/skill-market/desktop-provider.tsx`
- Create: `packages/app/src/skill-market/desktop-actions.tsx`
- Create: `packages/app/src/skill-market/desktop-actions.test.tsx`
- Modify: `packages/app/src/skill-market/detail.tsx`
- Modify: `packages/app/src/skill-market/list.tsx`

**Interfaces:**
- Consumes: desktop source/actions, `SkillMarket.Detail`, installed manifests and existing Dialog/Toast components.
- Produces: `DesktopSkillMarketProvider`, `DesktopSkillActions(props: { detail: SkillMarket.Detail })`, installed/update badges, and deterministic query invalidation.

- [ ] **Step 1: Write normal/risk/update/uninstall tests**

```tsx
test("requires explicit second confirmation for a risky install", async () => {
  const install = mock(() => Promise.resolve(sampleOperation()))
  const view = render(() => <DesktopActionsTest detail={sampleDetail({ risk: "warning", securityReports: [warningReport()] })} install={install} />)
  await userEvent.click(view.getByRole("button", { name: "安装" }))
  expect(view.getByText(warningReport().summary)).toBeTruthy()
  expect(view.getByRole("button", { name: "确认风险并安装" })).toBeDisabled()
  await userEvent.click(view.getByRole("checkbox", { name: "我已阅读并接受该 Skill 的风险" }))
  await userEvent.click(view.getByRole("button", { name: "确认风险并安装" }))
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ riskConfirmed: true }))
})

test("does not mutate on uninstall until the confirmation dialog is accepted", async () => {
  const uninstall = mock(() => Promise.resolve())
  const view = render(() => <InstalledActionsTest uninstall={uninstall} />)
  await userEvent.click(view.getByRole("button", { name: "卸载" }))
  expect(uninstall).not.toHaveBeenCalled()
  await userEvent.click(view.getByRole("button", { name: "确认卸载" }))
  expect(uninstall).toHaveBeenCalledTimes(1)
})
```

Add ordinary one-click install, installing disabled state, success invalidation, update action, delisted-no-install, refresh-failed retry, mutation error toast and dialog keyboard/focus return tests.

- [ ] **Step 2: Verify action tests fail**

Run: `cd packages/app && bun run test:unit -- src/skill-market/desktop-actions.test.tsx`

Expected: FAIL because Desktop actions do not exist.

- [ ] **Step 3: Implement installed status and mutation ownership**

Use one provider-level query:

```ts
const installed = createQuery(() => ({
  queryKey: ["skill-market", "installed"] as const,
  queryFn: ({ signal }) => market.source.installed?.(signal) ?? Promise.resolve([]),
  staleTime: 5_000,
}))
const byKey = createMemo(() => new Map((installed.data ?? []).map((item) => [`${item.source}:${item.id}`, item])))

const invalidate = () => Promise.all([
  client.invalidateQueries({ queryKey: ["skill-market", "installed"] }),
  client.invalidateQueries({ queryKey: ["skill-market", "updates"] }),
  client.invalidateQueries({ queryKey: ["skill-market", "list"] }),
  client.invalidateQueries({ queryKey: ["skill-market", "detail"] }),
])
```

Do not optimistically mark an install successful. Disable only the active Skill key so unrelated rows remain operable.

- [ ] **Step 4: Implement exact action state machine**

```ts
export type DesktopActionState =
  | { type: "available" }
  | { type: "installing" }
  | { type: "installed"; version: string }
  | { type: "updating"; version: string }
  | { type: "update-available"; installed: string; available: string }
  | { type: "refresh-failed"; version: string }
  | { type: "delisted"; installed?: string }
```

`risk === "safe"` installs immediately. `unknown`, `warning`, and `danger` open the report dialog and send `riskConfirmed: true` only after checkbox confirmation. Update uses the same risk policy. Uninstall always opens its own confirmation. On `refresh-failed`, show “已安装，加载失败” plus “重试加载”; never report the installation as rolled back.

- [ ] **Step 5: Run action/list/detail tests**

Run: `cd packages/app && bun run test:unit -- src/skill-market/desktop-actions.test.tsx src/skill-market/list.test.tsx src/skill-market/detail.test.tsx && bun typecheck`

Expected: all shared and Desktop action tests pass; App typechecks.

- [ ] **Step 6: Commit Desktop actions**

```bash
git add packages/app/src/skill-market/desktop-provider.tsx packages/app/src/skill-market/desktop-actions.tsx packages/app/src/skill-market/desktop-actions.test.tsx packages/app/src/skill-market/detail.tsx packages/app/src/skill-market/list.tsx
git commit -m "feat(app): manage installed market skills"
```

### Task 3: Add full-screen routes and both layout entry points

**Files:**
- Create: `packages/app/src/pages/skill-market.tsx`
- Create: `packages/app/src/pages/skill-market.test.tsx`
- Modify: `packages/app/src/env.d.ts`
- Modify: `packages/app/src/app.tsx`
- Modify: `packages/app/src/pages/layout/sidebar-shell.tsx`
- Modify: `packages/app/src/pages/layout.tsx`
- Modify: `packages/app/src/components/titlebar.tsx`
- Modify: `packages/app/src/pages/layout-new.tsx`

**Interfaces:**
- Consumes: `useServerSDK()`, shared market provider/list/detail, router, command context and `VITE_RUYING_SKILL_MARKET_ENABLED`.
- Produces: `/skills`, `/skills/:source/:id`, old sidebar entry above Settings, new titlebar entry, and command `skillMarket.open`.

- [ ] **Step 1: Write route and entry wiring tests**

```tsx
test("old sidebar places Skills immediately before Settings and navigates to the market", async () => {
  const view = renderLegacyLayout({ path: "/" })
  const rail = view.getByRole("navigation", { name: "项目和会话" })
  const buttons = within(rail).getAllByRole("button")
  expect(buttons.findIndex((button) => button.getAttribute("aria-label") === "Skills")).toBe(buttons.findIndex((button) => button.getAttribute("aria-label") === "设置") - 1)
  await userEvent.click(within(rail).getByRole("button", { name: "Skills" }))
  expect(testLocation()).toBe("/skills")
})

test("renders list and shareable detail routes without an iframe", async () => {
  const list = renderApp({ path: "/skills" })
  expect(await list.findByRole("heading", { name: "Skill 市场" })).toBeTruthy()
  expect(list.container.querySelector("iframe")).toBeNull()
  const detail = renderApp({ path: "/skills/skillhub/code-review" })
  expect(await detail.findByRole("heading", { name: "Code Review" })).toBeTruthy()
})
```

Add disabled-feature tests proving there is no entry, command or route; new-layout titlebar/command tests; browser back from detail to preserved list filters; and direct detail URL tests.

- [ ] **Step 2: Verify routing tests fail**

Run: `cd packages/app && bun run test:unit -- src/pages/skill-market.test.tsx`

Expected: FAIL because the page/routes/entries are missing.

- [ ] **Step 3: Implement the Desktop market route page**

Add `readonly VITE_RUYING_SKILL_MARKET_ENABLED?: string` to `ImportMetaEnv` and define `skillMarketEnabled` as `import.meta.env.VITE_RUYING_SKILL_MARKET_ENABLED !== "false"`; this OEM build defaults the market on but supports an explicit off switch.

```tsx
export function SkillMarketRoute() {
  const sdk = useServerSDK()
  const params = useParams<{ source?: string; id?: string }>()
  const navigate = useNavigate()
  const market = createMemo(() => createDesktopSkillMarket(sdk.client))
  const key = createMemo(() => parseSkillKey(params.source, params.id))
  return <SkillMarketProvider source={market().source} actions={market().actions}>
    <DesktopSkillMarketProvider>
      <div class="ruying-skill-market size-full overflow-hidden">
        <Show when={key()} fallback={<SkillMarketList onOpen={(value) => navigate(`/skills/${value.source}/${encodeURIComponent(value.id)}`)} />} keyed>
          {(value) => <SkillMarketDetail skill={value} onBack={() => navigate("/skills")} />}
        </Show>
      </div>
    </DesktopSkillMarketProvider>
  </SkillMarketProvider>
}
```

`parseSkillKey` accepts only `skillhub|enterprise`, decodes the ID once, and shows the not-found state on invalid input.

- [ ] **Step 4: Register routes before the generic `/:dir` route**

Inside the existing `RuntimeServerLayout` group, before `/:dir`, add guarded `/skills` and `/skills/:source/:id` routes. Because `RuntimeServerLayout` already chooses Legacy shell vs New shell, the market receives exactly one shell in either layout. When disabled, route components return `<Navigate href="/" />`.

- [ ] **Step 5: Add navigation entry points**

Extend `SidebarContent` props with `skillsLabel`, `onOpenSkills`, and render this exact button between `renderUser` and Settings:

```tsx
<Tooltip placement={placement()} value={props.skillsLabel()}>
  <IconButton icon="brain" variant="ghost" size="large" onClick={props.onOpenSkills} aria-label={props.skillsLabel()} />
</Tooltip>
```

Only pass/render it when enabled. In new-layout `TitlebarV2Right`, add a `brain` icon button before updater with the same navigation. Register a shared command:

```ts
command.register("skill-market", () => skillMarketEnabled ? [{
  id: "skillMarket.open",
  title: language.t("skillMarket.open"),
  category: language.t("command.category.view"),
  onSelect: () => navigate("/skills"),
}] : [])
```

- [ ] **Step 6: Run route/entry and App regression tests**

Run: `cd packages/app && bun run test:unit -- src/pages/skill-market.test.tsx src/skill-market && bun typecheck`

Expected: both layouts, routes and market components pass; App typechecks.

- [ ] **Step 7: Commit route integration**

```bash
git add packages/app/src/pages/skill-market.tsx packages/app/src/pages/skill-market.test.tsx packages/app/src/env.d.ts packages/app/src/app.tsx packages/app/src/pages/layout/sidebar-shell.tsx packages/app/src/pages/layout.tsx packages/app/src/components/titlebar.tsx packages/app/src/pages/layout-new.tsx
git commit -m "feat(app): add skill market navigation"
```

### Task 4: Add complete user-visible copy and stable errors

**Files:**
- Modify: `packages/app/src/i18n/en.ts`
- Modify: `packages/app/src/i18n/zh.ts`
- Modify: `packages/app/src/i18n/zht.ts`
- Modify: `packages/app/src/i18n/ar.ts`
- Modify: `packages/app/src/i18n/br.ts`
- Modify: `packages/app/src/i18n/bs.ts`
- Modify: `packages/app/src/i18n/da.ts`
- Modify: `packages/app/src/i18n/de.ts`
- Modify: `packages/app/src/i18n/es.ts`
- Modify: `packages/app/src/i18n/fr.ts`
- Modify: `packages/app/src/i18n/ja.ts`
- Modify: `packages/app/src/i18n/ko.ts`
- Modify: `packages/app/src/i18n/no.ts`
- Modify: `packages/app/src/i18n/pl.ts`
- Modify: `packages/app/src/i18n/ru.ts`
- Modify: `packages/app/src/i18n/th.ts`
- Modify: `packages/app/src/i18n/tr.ts`
- Modify: `packages/app/src/i18n/uk.ts`
- Modify: `packages/app/src/i18n/parity.test.ts`
- Create: `packages/app/src/skill-market/errors.test.ts`

**Interfaces:**
- Consumes: local error code union from Protocol and all UI labels introduced in Tasks 2–3.
- Produces: complete locale keys and `skillMarketErrorMessage(code, t): string`.

- [ ] **Step 1: Add error-code and parity tests**

```ts
test("maps every local error code to a user-visible localized key", () => {
  const codes = ["network-unavailable", "market-unavailable", "skill-delisted", "risk-confirmation-required", "hash-mismatch", "unsafe-archive", "archive-limit", "invalid-skill", "disk-unavailable", "version-conflict", "not-market-owned", "refresh-failed"] as const
  expect(codes.map((code) => skillMarketErrorKey(code))).toEqual(codes.map((code) => `skillMarket.error.${code}`))
})
```

- [ ] **Step 2: Verify parity fails after adding English keys only**

Add English keys, then run: `cd packages/app && bun test src/i18n/parity.test.ts src/skill-market/errors.test.ts`

Expected: FAIL listing the new keys missing from non-English dictionaries.

- [ ] **Step 3: Add the exact key vocabulary to every locale**

Required keys are:

```ts
"skillMarket.open": "Skills",
"skillMarket.title": "Skill 市场",
"skillMarket.search": "搜索 Skills",
"skillMarket.scope.all": "全部",
"skillMarket.scope.featured": "推荐精选",
"skillMarket.scope.enterprise": "企业精选",
"skillMarket.scope.installed": "已安装",
"skillMarket.scope.updates": "可更新",
"skillMarket.sort.trending": "近期飙升",
"skillMarket.sort.downloads": "下载量",
"skillMarket.sort.recent": "最近上新",
"skillMarket.filter.source": "来源",
"skillMarket.filter.category": "场景分类",
"skillMarket.filter.apiKey": "API Key",
"skillMarket.filter.all": "全部",
"skillMarket.view.list": "列表视图",
"skillMarket.view.cards": "卡片视图",
"skillMarket.tab.overview": "概述",
"skillMarket.tab.versions": "版本历史",
"skillMarket.tab.security": "安全报告",
"skillMarket.action.install": "安装",
"skillMarket.action.update": "升级",
"skillMarket.action.uninstall": "卸载",
"skillMarket.action.refresh": "重试加载",
"skillMarket.action.back": "返回 Skills",
"skillMarket.action.copyPrompt": "复制安装 Prompt",
"skillMarket.action.download": "下载 ZIP",
"skillMarket.action.confirmRisk": "确认风险并安装",
"skillMarket.action.confirmUninstall": "确认卸载",
"skillMarket.risk.accept": "我已阅读并接受该 Skill 的风险",
"skillMarket.state.installing": "安装中",
"skillMarket.state.installed": "已安装",
"skillMarket.state.updateAvailable": "可更新",
"skillMarket.state.refreshFailed": "已安装，加载失败",
"skillMarket.empty": "没有找到符合条件的 Skill",
"skillMarket.offline": "网络不可用，仍可管理已安装的 Skill",
"skillMarket.source.stale": "部分来源暂时不可用，当前展示最近一次成功数据",
"skillMarket.risk.unknown": "风险未知",
"skillMarket.risk.safe": "安全",
"skillMarket.risk.warning": "存在风险",
"skillMarket.risk.danger": "高风险",
```

Add `skillMarket.error.<code>` for all 12 codes from Step 1. `zh.ts` uses the Chinese strings above and precise Chinese error descriptions; `zht.ts` uses Traditional Chinese. English uses clear English equivalents. For the other 15 locale files, use their translated terms where maintained; if no reviewer is available, use the exact English values rather than leaving a key empty or machine-inventing a dangerous error meaning.

- [ ] **Step 4: Use only stable localized error mappings in UI**

```ts
export function skillMarketErrorKey(code: MarketLocalErrorCode) {
  return `skillMarket.error.${code}` as const
}

export function skillMarketErrorMessage(error: unknown, t: Translator) {
  if (error instanceof MarketLocalError) return t(skillMarketErrorKey(error.code))
  return t("skillMarket.error.market-unavailable")
}
```

Do not display raw filesystem paths, upstream response bodies or exception stacks in toasts/dialogs.

- [ ] **Step 5: Run i18n, errors and App typecheck**

Run: `cd packages/app && bun test src/i18n/parity.test.ts src/skill-market/errors.test.ts && bun typecheck`

Expected: every dictionary has identical keys/placeholders, error mapping test passes, App typechecks.

- [ ] **Step 6: Commit localized copy**

```bash
git add packages/app/src/i18n packages/app/src/skill-market/errors.test.ts packages/app/src/skill-market/desktop-source.ts
git commit -m "feat(app): localize skill market states"
```

### Task 5: Verify Desktop flows, offline behavior and large-list responsiveness

**Files:**
- Create: `packages/app/e2e/skill-market.spec.ts`
- Create: `packages/app/e2e/fixtures/skill-market.ts`
- Create: `packages/app/src/skill-market/large-list.test.tsx`
- Modify: `packages/app/playwright.config.ts`

**Interfaces:**
- Consumes: real App router/shared UI and a deterministic local Sidecar fixture implementing the generated endpoints.
- Produces: browser acceptance for ordinary/risky install, update, uninstall, offline installed management, no-restart refresh and 80k server-paged UI behavior.

- [ ] **Step 1: Write end-to-end Desktop scenarios**

```ts
test("installs a safe Skill and shows it as available without restarting", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Skills" }).click()
  await page.getByRole("button", { name: /Code Review/ }).click()
  await page.getByRole("button", { name: "安装" }).click()
  await expect(page.getByText("已安装")).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("button", { name: /Code Review/ }).getByText("已安装")).toBeVisible()
  expect(fixture.processRestartCount).toBe(0)
})

test("manages installed Skills while the catalog is offline", async ({ page }) => {
  fixture.catalogOnline = false
  await page.goto("/skills")
  await page.getByRole("button", { name: "已安装" }).click()
  await expect(page.getByText("网络不可用，仍可管理已安装的 Skill")).toBeVisible()
  await page.getByRole("button", { name: "卸载" }).click()
  await page.getByRole("button", { name: "确认卸载" }).click()
  await expect(page.getByText("已安装", { exact: true })).toHaveCount(0)
})
```

Add warning/danger explicit confirmation, cancel risk, update, update rollback error, refresh-failed retry, delisted installed Skill, filter state across back navigation, old/new layout entry, feature disabled, keyboard and fixed-light-in-dark-host scenarios.

- [ ] **Step 2: Add a UI large-list test without loading 80k DOM nodes**

```tsx
test("requests one server page and virtualizes visible rows for an 80000 item catalog", async () => {
  const source = pagedSource({ total: 80_000, returned: 30 })
  const view = render(() => <TestMarket source={source}><SkillMarketList onOpen={() => undefined} /></TestMarket>)
  await view.findByText("80,000")
  expect(source.calls).toEqual([expect.objectContaining({ page: 1, limit: 30 })])
  expect(view.container.querySelectorAll('[data-slot="skill-row"]').length).toBeLessThanOrEqual(30)
})
```

- [ ] **Step 3: Run E2E once to establish fixture/config failures**

Run: `cd packages/app && bunx playwright test e2e/skill-market.spec.ts`

Expected: FAIL until the Sidecar fixture and route setup are complete.

- [ ] **Step 4: Implement the deterministic Sidecar fixture**

The fixture serves real JSON conforming to Schema, records mutation requests, changes installed state only on successful responses, exposes a catalog-online toggle, and simulates `refresh-failed` and update rollback error codes. It must not reach SkillHub/OSS or mutate the developer's real config directory.

- [ ] **Step 5: Run the complete Desktop UI gate**

Run: `cd packages/app && bun run test:unit -- src/skill-market src/pages/skill-market.test.tsx && bun test src/i18n/parity.test.ts && bun typecheck`

Expected: all unit/large-list/route/i18n tests pass and App typechecks.

Run: `cd packages/app && bunx playwright test e2e/skill-market.spec.ts`

Expected: all Desktop market scenarios pass in Chromium with no app/server restart.

- [ ] **Step 6: Commit Desktop acceptance**

```bash
git add packages/app/e2e/skill-market.spec.ts packages/app/e2e/fixtures/skill-market.ts packages/app/src/skill-market/large-list.test.tsx packages/app/playwright.config.ts
git commit -m "test(app): verify desktop skill market"
```

## Plan Completion Gate

- Old layout renders the brain/Skills button immediately above Settings; new layout has the titlebar button and command.
- `/skills` and `/skills/:source/:id` render native shared components with no iframe and retain fixed-light market styling.
- Renderer imports no Core/Server/Node filesystem module and does not receive arbitrary package URLs from user input.
- Risk install requires visible report + checkbox + second confirmation; direct API bypass remains blocked by Server tests.
- Install/update/uninstall invalidates all relevant queries and never requires an application restart.
- Offline installed inventory remains usable; excluded community controls are absent.
