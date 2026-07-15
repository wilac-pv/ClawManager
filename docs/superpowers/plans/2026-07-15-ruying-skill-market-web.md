# Ruying Skill Market Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可独立访问、固定浅色、与桌面端共享组件的 Skill 市场 Web，支持浏览、搜索、筛选、详情深链、复制安装 Prompt 和下载 ZIP。

**Architecture:** 共享 Solid 组件放在 `@opencode-ai/app/skill-market`，通过 `SkillMarketDataSource` 和区分 Web/Desktop 的 `SkillMarketActions` 隔离运行环境；新建 `@opencode-ai/skill-market-web` 提供远程 API 适配器、路由入口和静态构建。Web 只调用远程只读 API，不接触本地 Sidecar，不写文件系统。

**Tech Stack:** SolidJS、Vite、`@solidjs/router`、TanStack Solid Query/Virtual、DOMPurify、Marked、Playwright、Bun test。

## Global Constraints

- 只进入 `ruying-code-oem`。
- 固定浅色视觉尽量一比一参考 SkillHub，不跟随宿主深色主题。
- Web 允许浏览、复制 Prompt 和下载 ZIP；不得安装到本机、强制唤起客户端或请求 SkillHub 登录。
- 不出现收藏、评论、发布、账号同步或 API Key 管理入口。
- 搜索防抖 300 ms，并取消过期请求；分页/排序/筛选始终由服务端执行。
- 列表使用虚拟滚动，图标懒加载，列表 DTO 不包含 Markdown 正文。
- Markdown 必须清理脚本、事件属性、iframe 和不受信任嵌入；外链使用 `rel="noopener noreferrer"`。
- Web 发布根目录为 `/ai-coding/ruying-code/skill-market/`，`/skills/*` 必须回退到入口 HTML。
- App 运行时代码只依赖 Schema、Protocol/生成客户端，不新增 Core 或 Server 依赖。
- 测试必须从 `packages/app` 或 `packages/skill-market-web` 运行。

---

## File Structure

- `packages/app/src/skill-market/types.ts`：共享数据源、动作和路由参数接口。
- `packages/app/src/skill-market/provider.tsx`：查询缓存和运行环境注入。
- `packages/app/src/skill-market/list.tsx`：搜索、排序、筛选、列表/卡片和虚拟滚动。
- `packages/app/src/skill-market/detail.tsx`：概述、版本、安全报告和动作槽。
- `packages/app/src/skill-market/markdown.tsx`：统一安全 Markdown 渲染。
- `packages/app/src/skill-market/styles.css`：完全限定在 `.ruying-skill-market` 下的浅色视觉。
- `packages/app/src/skill-market/index.ts`：唯一共享导出入口。
- `packages/skill-market-web/src/data-source.ts`：远程 API Fetch 适配器。
- `packages/skill-market-web/src/app.tsx`：Web 路由和 Web 动作。
- `packages/skill-market-web/src/entry.tsx`：浏览器挂载。
- `packages/skill-market-web/index.html`、`vite.config.ts`：独立静态构建。
- `packages/skill-market-web/e2e/`：真实浏览器验收。

### Task 1: Create environment-neutral shared contracts and provider

**Files:**
- Create: `packages/app/src/skill-market/types.ts`
- Create: `packages/app/src/skill-market/provider.tsx`
- Create: `packages/app/src/skill-market/index.ts`
- Modify: `packages/app/package.json`
- Create: `packages/app/src/skill-market/provider.test.tsx`

**Interfaces:**
- Consumes: `SkillMarket.PageQuery`, `Page`, `Facets`, `Detail`, `Installed`, `InstallRequest`, `OperationResult` from `@opencode-ai/schema/skill-market`.
- Produces: `SkillMarketDataSource`, `SkillMarketActions`, `SkillMarketProvider`, `useSkillMarket`, `SkillMarketList`, and `SkillMarketDetail` exports at `@opencode-ai/app/skill-market`.

- [ ] **Step 1: Write a failing provider test**

Add the shared test helpers first:

Run: `cd packages/app && bun add -d @solidjs/testing-library@0.8.10 @testing-library/user-event@14.6.1`

Expected: `packages/app/package.json` and `bun.lock` record the two direct test dependencies.

```tsx
import { expect, test } from "bun:test"
import { render } from "@solidjs/testing-library"
import { SkillMarketProvider, useSkillMarket } from "./provider"

test("provides the selected data source and web actions", () => {
  const source = testDataSource()
  const actions = { kind: "web" as const, copyPrompt: async () => undefined, download: async () => undefined }
  const Probe = () => <div>{useSkillMarket().actions.kind}:{useSkillMarket().source === source ? "source" : "wrong"}</div>
  const view = render(() => <SkillMarketProvider source={source} actions={actions}><Probe /></SkillMarketProvider>)
  expect(view.getByText("web:source")).toBeTruthy()
})
```

- [ ] **Step 2: Verify the provider test fails**

Run: `cd packages/app && bun run test:unit -- src/skill-market/provider.test.tsx`

Expected: FAIL because `provider.tsx` does not exist.

- [ ] **Step 3: Define exact shared interfaces**

```ts
import type { SkillMarket } from "@opencode-ai/schema/skill-market"

export type SkillKey = { source: SkillMarket.Source; id: string }
export type SkillMarketDataSource = {
  list: (query: SkillMarket.PageQuery, signal?: AbortSignal) => Promise<SkillMarket.Page>
  facets: (signal?: AbortSignal) => Promise<SkillMarket.Facets>
  detail: (key: SkillKey, signal?: AbortSignal) => Promise<SkillMarket.Detail>
  versions: (key: SkillKey, signal?: AbortSignal) => Promise<readonly SkillMarket.Version[]>
  download?: (key: SkillKey, signal?: AbortSignal) => Promise<SkillMarket.Download>
  installed?: (signal?: AbortSignal) => Promise<readonly SkillMarket.Installed[]>
  updates?: (signal?: AbortSignal) => Promise<readonly SkillMarket.Installed[]>
}

export type SkillMarketActions =
  | { kind: "web"; copyPrompt: (detail: SkillMarket.Detail) => Promise<void>; download: (detail: SkillMarket.Detail) => Promise<void> }
  | {
      kind: "desktop"
      install: (input: SkillMarket.InstallRequest) => Promise<SkillMarket.OperationResult>
      update: (input: SkillMarket.InstallRequest) => Promise<SkillMarket.OperationResult>
      uninstall: (key: SkillKey) => Promise<void>
      refresh: (key: SkillKey) => Promise<void>
    }
```

`provider.tsx` uses `createContext`, throws `SkillMarketProvider is missing` outside the provider, and stores the exact source/actions references without transforming them. Export `./skill-market` from `packages/app/package.json` as `./src/skill-market/index.ts`.

- [ ] **Step 4: Run provider test and App typecheck**

Run: `cd packages/app && bun run test:unit -- src/skill-market/provider.test.tsx && bun typecheck`

Expected: provider test passes and typecheck exits 0.

- [ ] **Step 5: Commit shared boundaries**

```bash
git add packages/app/package.json packages/app/src/skill-market/types.ts packages/app/src/skill-market/provider.tsx packages/app/src/skill-market/provider.test.tsx packages/app/src/skill-market/index.ts bun.lock
git commit -m "feat(app): add skill market provider"
```

### Task 2: Build the fixed-light catalog list

**Files:**
- Create: `packages/app/src/skill-market/list.tsx`
- Create: `packages/app/src/skill-market/styles.css`
- Create: `packages/app/src/skill-market/list.test.tsx`
- Modify: `packages/app/src/skill-market/index.ts`

**Interfaces:**
- Consumes: `useSkillMarket().source.list/facets`, URL search params `q`, `sort`, `source`, `category`, `apiKey`, `page`, and an `onOpen(SkillKey)` callback.
- Produces: `SkillMarketList(props: { onOpen: (key: SkillKey) => void; installedOnly?: boolean }): JSX.Element`.

- [ ] **Step 1: Write list interaction tests**

```tsx
test("debounces search, sends server filters and opens a skill", async () => {
  const calls: SkillMarket.PageQuery[] = []
  const source = listDataSource((query) => calls.push(query))
  const opened: SkillKey[] = []
  const view = render(() => <TestMarket source={source}><SkillMarketList onOpen={(key) => opened.push(key)} /></TestMarket>)
  await userEvent.type(view.getByRole("searchbox"), "review")
  await new Promise((resolve) => setTimeout(resolve, 350))
  expect(calls.at(-1)?.query).toBe("review")
  await userEvent.selectOptions(view.getByLabelText("来源"), "enterprise")
  expect(calls.at(-1)?.source).toBe("enterprise")
  await userEvent.click(await view.findByRole("button", { name: /Code Review/ }))
  expect(opened).toEqual([{ source: "skillhub", id: "code-review" }])
})
```

Add assertions for sorting tabs, API Key filter, list/card toggle persistence in `localStorage`, empty state, stale-source banner, icon fallback, keyboard focus, and absence of community controls.

- [ ] **Step 2: Verify tests fail before list exists**

Run: `cd packages/app && bun run test:unit -- src/skill-market/list.test.tsx`

Expected: FAIL for missing `SkillMarketList`.

- [ ] **Step 3: Implement list state and remote query cancellation**

Use `createStore` for UI state. The request key is exactly:

```ts
const query = createMemo<SkillMarket.PageQuery>(() => ({
  query: debounced().trim() || undefined,
  source: state.source || undefined,
  category: state.category || undefined,
  requiresApiKey: state.apiKey === "all" ? undefined : state.apiKey === "yes",
  featured: state.scope === "featured" ? true : undefined,
  enterprise: state.scope === "enterprise" ? true : undefined,
  sort: state.sort,
  page: state.page,
  limit: 30,
}))

const result = createQuery(() => ({
  queryKey: ["skill-market", "list", query()] as const,
  queryFn: ({ signal }) => source.list(query(), signal),
  enabled: state.scope !== "installed" && state.scope !== "updates",
  placeholderData: (previous) => previous,
}))

const installed = createQuery(() => ({
  queryKey: ["skill-market", "installed"] as const,
  queryFn: ({ signal }) => source.installed?.(signal) ?? Promise.resolve([]),
  enabled: state.scope === "installed" && source.installed !== undefined,
}))
const updates = createQuery(() => ({
  queryKey: ["skill-market", "updates"] as const,
  queryFn: ({ signal }) => source.updates?.(signal) ?? Promise.resolve([]),
  enabled: state.scope === "updates" && source.updates !== undefined,
}))
```

Render tabs `全部 / 推荐精选 / 近期飙升 / 下载量 / 最近上新`, filters `来源 / 场景分类 / API Key`, the `企业精选` scope, and view buttons. Render `已安装` and `可更新` only when `source.installed`/`source.updates` exist; therefore they appear in Desktop and never appear in standalone Web. The installed branch renders manifest name/source/version/load state without calling remote list/detail, and when actions are Desktop it offers inline uninstall and refresh-failed retry so offline management remains possible. The updates branch uses only `source.updates` and opens the detail/update action for the selected key. Use `@tanstack/solid-virtual` for list rows, `loading="lazy"` for icons, and a source-initial fallback avatar.

- [ ] **Step 4: Add fully scoped fixed-light styles**

```css
.ruying-skill-market {
  color-scheme: light;
  --market-bg: #f7f8fa;
  --market-surface: #ffffff;
  --market-border: #e5e7eb;
  --market-text: #111827;
  --market-muted: #667085;
  --market-accent: #6d5dfc;
  background: var(--market-bg);
  color: var(--market-text);
  font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
  min-height: 100%;
}
.ruying-skill-market button:focus-visible,
.ruying-skill-market a:focus-visible,
.ruying-skill-market input:focus-visible,
.ruying-skill-market select:focus-visible { outline: 2px solid var(--market-accent); outline-offset: 2px; }
.ruying-skill-market__card { background: var(--market-surface); border: 1px solid var(--market-border); border-radius: 12px; }
.ruying-skill-market__risk--warning { color: #b54708; background: #fffaeb; }
.ruying-skill-market__risk--danger { color: #b42318; background: #fef3f2; }
```

All remaining selectors must start with `.ruying-skill-market`; do not alter global theme tokens.

`packages/app/src/skill-market/index.ts` imports `./styles.css` once before exporting the provider/list/detail modules, so both standalone Web and Desktop receive the identical scoped stylesheet.

- [ ] **Step 5: Run list tests and typecheck**

Run: `cd packages/app && bun run test:unit -- src/skill-market/list.test.tsx && bun typecheck`

Expected: all list tests pass; typecheck exits 0.

- [ ] **Step 6: Commit the shared list**

```bash
git add packages/app/src/skill-market/list.tsx packages/app/src/skill-market/list.test.tsx packages/app/src/skill-market/styles.css packages/app/src/skill-market/index.ts
git commit -m "feat(app): add skill market catalog list"
```

### Task 3: Build safe detail, versions and security tabs

**Files:**
- Create: `packages/app/src/skill-market/detail.tsx`
- Create: `packages/app/src/skill-market/markdown.tsx`
- Create: `packages/app/src/skill-market/detail.test.tsx`
- Modify: `packages/app/src/skill-market/styles.css`
- Modify: `packages/app/src/skill-market/index.ts`

**Interfaces:**
- Consumes: `SkillKey`, `source.detail`, `source.versions`, and the environment-discriminated `SkillMarketActions`.
- Produces: `SkillMarketDetail(props: { skill: SkillKey; onBack: () => void }): JSX.Element` with Web and Desktop action branches.

- [ ] **Step 1: Write security and Web-action tests**

```tsx
test("sanitizes markdown and exposes only web copy/download actions", async () => {
  const detail = sampleDetail({ readme: "# Safe\n<script>bad()</script><a href=\"javascript:bad()\">x</a>" })
  const copied: string[] = []
  const downloaded: string[] = []
  const view = render(() => <TestMarket detail={detail} actions={{ kind: "web", copyPrompt: async (value) => { copied.push(value.publicDetailUrl) }, download: async (value) => { downloaded.push(value.package.url) } }}><SkillMarketDetail skill={{ source: detail.source, id: detail.id }} onBack={() => undefined} /></TestMarket>)
  expect(await view.findByRole("heading", { name: detail.name })).toBeTruthy()
  expect(view.container.querySelector("script")).toBeNull()
  expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull()
  await userEvent.click(view.getByRole("button", { name: "复制安装 Prompt" }))
  await userEvent.click(view.getByRole("button", { name: "下载 ZIP" }))
  expect(copied).toEqual([detail.publicDetailUrl])
  expect(downloaded).toEqual([detail.package.url])
  expect(view.queryByRole("button", { name: "安装" })).toBeNull()
})
```

Add tests for overview/version/security tab keyboard navigation, warning/danger report display, source attribution, author/original link, delisted state, and loading/not-found states.

- [ ] **Step 2: Verify detail tests fail**

Run: `cd packages/app && bun run test:unit -- src/skill-market/detail.test.tsx`

Expected: FAIL because detail and markdown components do not exist.

- [ ] **Step 3: Implement one sanitized Markdown boundary**

```tsx
export function MarketMarkdown(props: { value: string }) {
  const html = createMemo(() => DOMPurify.sanitize(marked.parse(props.value) as string, {
    ALLOWED_TAGS: ["a", "blockquote", "br", "code", "em", "h1", "h2", "h3", "h4", "hr", "img", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"],
    ALLOWED_ATTR: ["alt", "href", "src", "title"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  }))
  createEffect(() => root?.querySelectorAll("a").forEach((anchor) => {
    anchor.target = "_blank"
    anchor.rel = "noopener noreferrer"
  }))
  let root: HTMLDivElement | undefined
  return <div ref={root} class="ruying-skill-market__markdown" innerHTML={html()} />
}
```

The image sanitizer must additionally reject non-HTTPS `src` values after DOMPurify processing.

- [ ] **Step 4: Implement detail tabs and environment actions**

The Web branch builds the copied text exactly as:

```ts
export function installPrompt(detail: SkillMarket.Detail) {
  return `请安装并使用这个 Skill：${detail.name}\n详情：${detail.publicDetailUrl}\n来源：${detail.sourceUrl}\n版本：${detail.version}\nSHA-256：${detail.package.sha256}`
}
```

The page displays breadcrumb `Skills / {name}`, icon/fallback, name, description, version, updated time, source, author, license, score, downloads, category and risk. Tabs use buttons with `role="tab"`; security reports display provider/verdict/summary/report link. The Desktop action branch renders status-driven controls defined in the desktop plan but must not import Desktop code.

- [ ] **Step 5: Run shared detail verification**

Run: `cd packages/app && bun run test:unit -- src/skill-market/detail.test.tsx && bun typecheck`

Expected: all detail/security/action tests pass and typecheck exits 0.

- [ ] **Step 6: Commit shared detail UI**

```bash
git add packages/app/src/skill-market/detail.tsx packages/app/src/skill-market/markdown.tsx packages/app/src/skill-market/detail.test.tsx packages/app/src/skill-market/styles.css packages/app/src/skill-market/index.ts
git commit -m "feat(app): add skill market detail view"
```

### Task 4: Create the standalone Web application and remote adapter

**Files:**
- Create: `packages/skill-market-web/package.json`
- Create: `packages/skill-market-web/tsconfig.json`
- Create: `packages/skill-market-web/vite.config.ts`
- Create: `packages/skill-market-web/index.html`
- Create: `packages/skill-market-web/src/data-source.ts`
- Create: `packages/skill-market-web/src/app.tsx`
- Create: `packages/skill-market-web/src/entry.tsx`
- Create: `packages/skill-market-web/src/env.d.ts`
- Create: `packages/skill-market-web/src/data-source.test.ts`

**Interfaces:**
- Consumes: remote routes from `SkillMarketCatalogApi` and shared UI from `@opencode-ai/app/skill-market`.
- Produces: static routes `/skills` and `/skills/:source/:id`, plus `createRemoteSkillMarketDataSource(baseUrl): SkillMarketDataSource`.

- [ ] **Step 1: Write remote adapter tests against a real local HTTP server**

Create the package shell:

```json
{
  "$schema": "https://json.schemastore.org/package.json",
  "name": "@opencode-ai/skill-market-web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview", "test": "bun test", "typecheck": "tsgo --noEmit", "test:e2e": "playwright test" },
  "dependencies": { "@aws-sdk/client-s3": "3.933.0", "@opencode-ai/app": "workspace:*", "@opencode-ai/schema": "workspace:*", "@solidjs/router": "catalog:", "effect": "catalog:", "solid-js": "catalog:" },
  "devDependencies": { "@playwright/test": "catalog:", "@tsconfig/bun": "catalog:", "@types/bun": "catalog:", "@typescript/native-preview": "catalog:", "typescript": "catalog:", "vite": "catalog:", "vite-plugin-solid": "catalog:" }
}
```

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@tsconfig/bun/tsconfig.json",
  "compilerOptions": { "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler", "jsx": "preserve", "jsxImportSource": "solid-js", "strict": true, "noEmit": true },
  "include": ["src", "e2e", "vite.config.ts", "package.json"]
}
```

```ts
test("encodes list filters and decodes the response schema", async () => {
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url)
    expect(url.searchParams.get("query")).toBe("code review")
    expect(url.searchParams.get("requiresApiKey")).toBe("false")
    return Response.json(samplePage())
  } })
  using _server = { [Symbol.dispose]: () => server.stop(true) }
  const source = createRemoteSkillMarketDataSource(`http://127.0.0.1:${server.port}`)
  const page = await source.list({ query: "code review", requiresApiKey: false, sort: "score", page: 1, limit: 30 })
  expect(page.total).toBe(1)
})
```

Add malformed JSON, non-2xx, abort, detail path escaping and version tests. HTTP is allowed only for the loopback test base; production config validation requires HTTPS.

- [ ] **Step 2: Verify adapter tests fail**

Run: `cd packages/skill-market-web && bun test src/data-source.test.ts`

Expected: FAIL because the package and adapter are missing.

- [ ] **Step 3: Implement the fetch adapter with Schema decoding**

```ts
export function createRemoteSkillMarketDataSource(baseUrl: string): SkillMarketDataSource {
  const get = async <A>(path: string, schema: Schema.Schema<A>, signal?: AbortSignal) => {
    const response = await fetch(new URL(path, baseUrl), { signal, headers: { accept: "application/json" } })
    if (!response.ok) throw new MarketHttpError(response.status)
    return Schema.decodeUnknownPromise(schema)(await response.json())
  }
  return {
    list: (query, signal) => get(`/v1/catalog/skills?${encodePageQuery(query)}`, SkillMarket.Page, signal),
    facets: (signal) => get("/v1/catalog/facets", SkillMarket.Facets, signal),
    detail: (key, signal) => get(`/v1/catalog/skills/${key.source}/${encodeURIComponent(key.id)}`, SkillMarket.Detail, signal),
    versions: (key, signal) => get(`/v1/catalog/skills/${key.source}/${encodeURIComponent(key.id)}/versions`, Schema.Array(SkillMarket.Version), signal),
    download: (key, signal) => get(`/v1/catalog/skills/${key.source}/${encodeURIComponent(key.id)}/download`, SkillMarket.Download, signal),
  }
}
```

`encodePageQuery` omits `undefined`, preserves `false`, and never serializes unknown keys.

```ts
export class MarketHttpError extends Error {
  constructor(readonly status: number) {
    super(`Skill market request failed with status ${status}`)
  }
}

function encodePageQuery(query: SkillMarket.PageQuery) {
  const params = new URLSearchParams()
  if (query.query !== undefined) params.set("query", query.query)
  if (query.source !== undefined) params.set("source", query.source)
  if (query.category !== undefined) params.set("category", query.category)
  if (query.requiresApiKey !== undefined) params.set("requiresApiKey", String(query.requiresApiKey))
  if (query.featured !== undefined) params.set("featured", String(query.featured))
  if (query.enterprise !== undefined) params.set("enterprise", String(query.enterprise))
  params.set("sort", query.sort)
  params.set("page", String(query.page))
  params.set("limit", String(query.limit))
  return params.toString()
}
```

- [ ] **Step 4: Implement standalone routes and Web actions**

```tsx
export function App() {
  const navigate = useNavigate()
  const source = createRemoteSkillMarketDataSource(import.meta.env.VITE_SKILL_MARKET_API_URL)
  const actions: SkillMarketActions = {
    kind: "web",
    copyPrompt: async (detail) => navigator.clipboard.writeText(installPrompt(detail)),
    download: async (detail) => {
      const target = await source.download?.({ source: detail.source, id: detail.id })
      if (!target) throw new Error("Skill market download endpoint is unavailable")
      window.location.assign(target.url)
    },
  }
  return <SkillMarketProvider source={source} actions={actions}>
    <Routes>
      <Route path="/skills" component={() => <SkillMarketList onOpen={(key) => navigate(`/skills/${key.source}/${encodeURIComponent(key.id)}`)} />} />
      <Route path="/skills/:source/:id" component={WebSkillDetailRoute} />
      <Route path="*" component={() => <Navigate href="/skills" />} />
    </Routes>
  </SkillMarketProvider>
}
```

Declare `VITE_SKILL_MARKET_API_URL: string` in `src/env.d.ts`. Mount the app with the same shared providers and a router base that works at the OSS prefix:

```tsx
import { Router } from "@solidjs/router"
import { AppBaseProviders } from "@opencode-ai/app"
import { render } from "solid-js/web"
import { App } from "./app"
import "@opencode-ai/app/index.css"
import "@opencode-ai/app/skill-market"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root")
render(() => <AppBaseProviders locale="zh"><Router base={import.meta.env.BASE_URL.replace(/\/$/, "")}><App /></Router></AppBaseProviders>, root)
```

Set Vite `base` to `/ai-coding/ruying-code/skill-market/` for production and `/` in test/dev. `index.html` includes a Chinese title/description and no install/deep-link script.

```ts
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig(({ mode }) => ({
  base: mode === "production" ? "/ai-coding/ruying-code/skill-market/" : "/",
  plugins: [solid()],
  server: { host: "127.0.0.1", port: 4211 },
  build: { target: "es2022", sourcemap: true },
}))
```

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="浏览、搜索和下载如影 Code Skills" />
    <title>如影 Code Skill 市场</title>
  </head>
  <body><div id="root"></div><script type="module" src="/src/entry.tsx"></script></body>
</html>
```

- [ ] **Step 5: Run package tests, typecheck and production build**

Run: `cd packages/skill-market-web && bun test && bun typecheck && bun run build`

Expected: tests/typecheck pass; `dist/index.html` and hashed assets are created with the production base path.

- [ ] **Step 6: Commit standalone Web**

```bash
git add packages/skill-market-web
git commit -m "feat(skill-market): add standalone web app"
```

### Task 5: Add browser acceptance, accessibility and OSS release procedure

**Files:**
- Create: `packages/skill-market-web/playwright.config.ts`
- Create: `packages/skill-market-web/e2e/market.spec.ts`
- Create: `packages/skill-market-web/e2e/fixtures/catalog.ts`
- Create: `packages/skill-market-web/script/release.ts`
- Create: `packages/skill-market-web/README.md`
- Modify: `packages/skill-market-web/package.json`

**Interfaces:**
- Consumes: production static build and the five remote catalog routes.
- Produces: `bun run test:e2e`, immutable Web release uploads, and a pointer/rollback manifest.

- [ ] **Step 1: Write end-to-end acceptance cases**

```ts
test("searches, filters, deep-links, copies a prompt and downloads ZIP", async ({ page }) => {
  await page.goto("/skills")
  await expect(page.getByRole("heading", { name: "Skill 市场" })).toBeVisible()
  await page.getByRole("searchbox").fill("review")
  await expect(page.getByRole("button", { name: /Code Review/ })).toBeVisible()
  await page.getByRole("button", { name: /Code Review/ }).click()
  await expect(page).toHaveURL(/\/skills\/skillhub\/code-review$/)
  await page.getByRole("button", { name: "复制安装 Prompt" }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("SHA-256")
  await expect(page.getByRole("button", { name: "安装" })).toHaveCount(0)
})
```

Add desktop/mobile viewports, list/card views, keyboard-only tab navigation, fixed light computed colors under a dark OS preference, direct detail navigation, 404, partial-source banner, empty state and failed icon fallback.

- [ ] **Step 2: Run E2E and observe failures before fixtures/config are complete**

Run: `cd packages/skill-market-web && bunx playwright test`

Expected: FAIL until the fixture API and Web server are configured.

- [ ] **Step 3: Configure deterministic fixture API and browser server**

The Playwright config starts one Bun fixture server and `vite --host 127.0.0.1`; fixture endpoints return a fixed revision and record download requests. Set `colorScheme: "dark"` in one project and assert `.ruying-skill-market` has a light RGB background. Do not intercept DOM or replace application components.

- [ ] **Step 4: Implement immutable OSS release upload**

`script/release.ts` computes `release = sha256(dist manifest).slice(0, 16)`, uploads all files to `skill-market/web/<release>/`, assigns `max-age=31536000, immutable` to hashed assets and `max-age=60` to HTML, then writes `skill-market/web/current.json` only after every uploaded object is HEAD-verified. The deployment layer maps the public base path and `/skills/*` fallback to that release's `index.html`.

- [ ] **Step 5: Run the complete Web gate**

Run: `cd packages/app && bun run test:unit -- src/skill-market && bun typecheck`

Expected: shared market tests pass and App typechecks.

Run: `cd packages/skill-market-web && bun test && bun typecheck && bun run build && bunx playwright test`

Expected: unit, typecheck, build and all browser projects pass.

- [ ] **Step 6: Commit browser and release support**

```bash
git add packages/skill-market-web/playwright.config.ts packages/skill-market-web/e2e packages/skill-market-web/script packages/skill-market-web/README.md packages/skill-market-web/package.json
git commit -m "test(skill-market): verify standalone web"
```

## Plan Completion Gate

- A direct request to `/skills/skillhub/code-review` renders the detail after static-host fallback.
- The Web bundle has no import from `@opencode-ai/core`, `@opencode-ai/server`, Desktop IPC, or local generated mutation clients.
- `rg -n "收藏|评论|发布 Skill|登录 SkillHub|唤起如影" packages/app/src/skill-market packages/skill-market-web/src` returns no product UI for excluded scope.
- Copy Prompt contains public detail URL, source, version and SHA-256; download uses only the server-supplied verified HTTPS URL.
- The same shared components remain consumable by the Desktop plan through `SkillMarketDataSource` and the `desktop` action union.
