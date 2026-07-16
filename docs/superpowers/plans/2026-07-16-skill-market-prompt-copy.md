# Skill 市场安装 Prompt 复制修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复私网 HTTP 部署中“复制安装 Prompt”无响应的问题，并为成功、处理中和失败状态提供明确反馈。

**Architecture:** Web 包新增独立剪贴板边界，先在用户手势内使用 DOM 兼容复制，再回退到现代 Clipboard API。共享详情组件等待 Web action，并渲染 `copying`、`copied`、`failed` 状态；失败时展示完整只读 Prompt，服务端和桌面行为不变。

**Tech Stack:** TypeScript、Bun、SolidJS、Happy DOM、Playwright、Vite、Nginx。

## Global Constraints

- 私网 HTTP、localhost 和 HTTPS 都必须支持复制。
- DOM 兼容复制必须先于现代 Clipboard API 执行。
- 不得产生未处理 Promise rejection。
- 成功、处理中和失败状态必须可见且可被辅助技术读取。
- 失败时必须保留手动复制完整 Prompt 的退路。
- 不修改下载 ZIP、桌面安装、Prompt 内容、API、数据库或 Nginx 配置。
- 测试不能从仓库根目录运行；类型检查使用包内 `bun typecheck`。

---

### Task 1: 私网 HTTP 剪贴板边界

**Files:**
- Create: `packages/skill-market-web/src/clipboard.ts`
- Create: `packages/skill-market-web/src/clipboard.test.ts`
- Modify: `packages/skill-market-web/src/app.tsx:1-52`

**Interfaces:**
- Consumes: `installPrompt(detail): string`。
- Produces: `copyText(value, adapters?): Promise<boolean>`；兼容复制成功即返回 `true`，否则尝试现代 API，两者失败返回 `false`。
- Produces: Web `copyPrompt(detail): Promise<void>`；`copyText` 返回 `false` 时拒绝 Promise。

- [ ] **Step 1: 写剪贴板失败测试**

在 `packages/skill-market-web/src/clipboard.test.ts` 创建三个测试：

```ts
test("copies through the synchronous private HTTP fallback before the Clipboard API", async () => {
  const legacy: string[] = []
  const modern: string[] = []
  expect(
    await copyText("install prompt", {
      legacy: (value) => {
        legacy.push(value)
        return true
      },
      modern: async (value) => {
        modern.push(value)
      },
    }),
  ).toBe(true)
  expect(legacy).toEqual(["install prompt"])
  expect(modern).toEqual([])
})

test("uses the Clipboard API after the private HTTP fallback declines", async () => {
  const modern: string[] = []
  expect(
    await copyText("install prompt", {
      legacy: () => false,
      modern: async (value) => {
        modern.push(value)
      },
    }),
  ).toBe(true)
  expect(modern).toEqual(["install prompt"])
})

test("reports failure when neither copy mechanism succeeds", async () => {
  expect(
    await copyText("install prompt", {
      legacy: () => false,
      modern: async () => Promise.reject(new Error("denied")),
    }),
  ).toBe(false)
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run from `packages/skill-market-web`:

```bash
bun test src/clipboard.test.ts
```

Expected: FAIL，因为 `./clipboard` 尚不存在。

- [ ] **Step 3: 实现最小剪贴板边界**

创建 `packages/skill-market-web/src/clipboard.ts`：

```ts
export async function copyText(
  value: string,
  adapters: {
    readonly legacy: (value: string) => boolean
    readonly modern?: (value: string) => Promise<void>
  } = {
    legacy: copyWithSelection,
    modern:
      typeof navigator === "undefined" || !navigator.clipboard?.writeText
        ? undefined
        : (value) => navigator.clipboard.writeText(value),
  },
) {
  if (adapters.legacy(value)) return true
  if (!adapters.modern) return false
  return adapters.modern(value).then(
    () => true,
    () => false,
  )
}

function copyWithSelection(value: string) {
  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") return false
  const target = document.createElement("textarea")
  target.value = value
  target.setAttribute("readonly", "")
  target.style.position = "fixed"
  target.style.opacity = "0"
  target.style.pointerEvents = "none"
  document.body.appendChild(target)
  target.select()
  try {
    return document.execCommand("copy")
  } finally {
    target.remove()
  }
}
```

将 `packages/skill-market-web/src/app.tsx` 的 Web action 改为：

```ts
copyPrompt: async (detail) => {
  if (await copyText(installPrompt(detail))) return
  throw new Error("Skill market install prompt could not be copied")
},
```

- [ ] **Step 4: 运行聚焦测试与类型检查确认 GREEN**

Run from `packages/skill-market-web`:

```bash
bun test src/clipboard.test.ts
bun typecheck
```

Expected: 三个测试 `0 fail`，类型检查退出 `0`。

- [ ] **Step 5: 提交剪贴板边界**

```bash
git add packages/skill-market-web/src/clipboard.ts packages/skill-market-web/src/clipboard.test.ts packages/skill-market-web/src/app.tsx
git commit -m "fix(skill-market): support private http prompt copy"
```

---

### Task 2: 复制按钮反馈与手动退路

**Files:**
- Modify: `packages/app/src/skill-market/detail.tsx:1-320`
- Modify: `packages/app/src/skill-market/detail.test.tsx:80-120`
- Modify: `packages/app/src/skill-market/styles.css:649-685`
- Modify: `packages/skill-market-web/e2e/market.e2e.ts:5-18`

**Interfaces:**
- Consumes: `SkillMarketActions.copyPrompt(detail): Promise<void>`。
- Produces: `idle | copying | copied | failed` 交互状态；失败状态使用现有 `installPrompt(detail)` 生成手动复制内容。

- [ ] **Step 1: 写详情组件失败测试**

在 `packages/app/src/skill-market/detail.test.tsx` 增加两个测试。成功测试使用受控 Promise，点击后断言按钮 disabled 且文本为“正在复制…”，resolve 后断言按钮文本为“已复制”并出现 `role="status"`。失败测试让 action reject，断言出现 `role="alert"`，并且 `getByRole("textbox", { name: "安装 Prompt" })` 的值等于 `installPrompt(detail)`。

- [ ] **Step 2: 运行测试确认 RED**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts src/skill-market/detail.test.tsx
```

Expected: FAIL，因为按钮没有 copying/copied/failed 状态，也没有手动复制文本域。

- [ ] **Step 3: 实现交互状态和样式**

在 `WebDetailActions` 内增加 `createSignal<"idle" | "copying" | "copied" | "failed">("idle")`，使用 Promise 的成功/失败分支更新状态且不产生未处理 rejection。按钮在 copying 时 disabled；copied 时显示“已复制”。失败时渲染：

```tsx
<p class="ruying-skill-market__copy-feedback" role="alert">
  自动复制失败，请手动复制下方 Prompt。
</p>
<textarea aria-label="安装 Prompt" readOnly value={installPrompt(props.detail)} />
```

成功时渲染 `role="status"` 的“安装 Prompt 已复制到剪贴板”。在 `styles.css` 为反馈和只读文本域添加全宽、可读、可聚焦样式。

- [ ] **Step 4: 更新 E2E 成功反馈断言**

在现有复制步骤后加入：

```ts
await expect(page.getByRole("button", { name: "已复制" })).toBeVisible()
await expect(page.getByRole("status")).toContainText("安装 Prompt 已复制到剪贴板")
```

保留对剪贴板内容包含 `SHA-256` 的断言。

- [ ] **Step 5: 运行聚焦验证并提交**

Run from `packages/app`:

```bash
bun test --preload ./happydom.ts src/skill-market/detail.test.tsx
bun typecheck
```

Run from `packages/skill-market-web`:

```bash
bun run test
bun typecheck
```

Expected: 所有命令退出 `0`。

```bash
git add packages/app/src/skill-market/detail.tsx packages/app/src/skill-market/detail.test.tsx packages/app/src/skill-market/styles.css packages/skill-market-web/e2e/market.e2e.ts
git commit -m "fix(skill-market): show prompt copy feedback"
```

---

### Task 3: 全量验证、合并与 Web 发布

**Files:**
- Verify: `packages/app/`
- Verify: `packages/skill-market-web/`
- Create generated artifact: `/tmp/ruying-skill-market-web-<release>.tar.gz`

**Interfaces:**
- Consumes: Task 1、Task 2 的提交。
- Produces: 新内容寻址 Web release；线上复制按钮反馈和实际 Prompt 剪贴板内容。

- [ ] **Step 1: 运行全量验证**

Run from `packages/app`:

```bash
bun run test
bun typecheck
```

Run from `packages/skill-market-web`:

```bash
bun run test
bun typecheck
bun run build
bun run test:e2e -- --project=desktop-light
```

Expected: App/Web 测试 `0 fail`，类型检查、构建和 desktop-light E2E 全部退出 `0`。

- [ ] **Step 2: 提交文档并快进合并**

```bash
git add docs/superpowers/plans/2026-07-16-skill-market-prompt-copy.md
git commit -m "docs(skill-market): plan prompt copy fallback"
git -C /Users/gwm/data/gitee/opencode merge --ff-only prompt-copy-fix
```

- [ ] **Step 3: 构建并安装不可变 Web release**

从合并后的 `dev` 清除 Vite API override，构建生产 Web，通过 `stageLocalWebRelease` 生成 16 位内容哈希 release 和 manifest。上传 tarball 到 `10.246.13.226:9922`，校验每个文件的大小与 SHA-256 后原子切换 `/srv/ruying-skill-market/web/current`，运行 `nginx -t` 并保留 `88b4fcf6277c7e02`。

- [ ] **Step 4: 验证线上行为**

确认新静态资源和详情深链接返回 200。浏览器点击“复制安装 Prompt”后必须显示“已复制”，剪贴板内容必须包含 Skill 名称、版本和 `SHA-256`；如果浏览器拒绝自动复制，则必须出现可手动复制的完整 Prompt，不能再无响应。

- [ ] **Step 5: 失败时回滚**

若 manifest、Nginx、页面加载或复制行为验证失败，将 Web `current` 原子恢复到 `88b4fcf6277c7e02`，再次验证 Nginx 和详情深链接，并保留候选 release 诊断。
