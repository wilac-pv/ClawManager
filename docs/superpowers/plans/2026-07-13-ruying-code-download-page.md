# 如影 Code 下载页实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个面向长城汽车内部研发人员、可直接静态部署、自动推荐 macOS 或 Windows 安装包的如影 Code 下载页。

**Architecture:** 在 `packages/ruying-download` 中创建无框架静态页面，HTML 负责语义内容，CSS 负责深色沉浸视觉与响应式布局，ES 模块负责系统识别和推荐态。Bun 单元测试验证内容契约与推荐逻辑，Playwright 在真实浏览器中验证交互和响应式行为。

**Tech Stack:** HTML5、CSS3、原生 JavaScript ES 模块、Bun test、Playwright

## Global Constraints

- 页面必须是无服务端、无第三方运行时依赖的静态目录。
- 页面必须按 HTTP-only 契约从 HTTP 来源部署，直到两个安装包获得浏览器可信的 HTTPS 地址或部署方提供同源 HTTPS 代理；不得将当前地址替换为证书链不受信任的 HTTPS 地址。
- 页面只使用简体中文，定位为“长城汽车内部研发工具”。
- macOS 下载地址固定为 `http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-mac-arm64.dmg`。
- Windows 下载地址固定为 `http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-win-x64.exe`。
- 系统识别只改变推荐状态，两个平台的普通 `<a>` 下载链接必须始终存在。
- 页面不得请求身份、分析或业务接口，不得添加埋点。
- 生产 HTML、JavaScript 和 CSS 只能包含两个批准的安装包外部 URL；初始页面加载只能请求同源 HTML、CSS、JavaScript 和本地图标。
- 必须提示当前安装包未签名，并覆盖 macOS 安全限制与 Windows SmartScreen。
- 必须遵循 `prefers-reduced-motion` 并提供清晰键盘焦点。

---

## File Structure

- `packages/ruying-download/index.html`：页面语义结构、产品文案、固定下载链接和无脚本降级内容。
- `packages/ruying-download/styles.css`：颜色令牌、深色主视觉、组件样式、断点、焦点态和减弱动画规则。
- `packages/ruying-download/app.js`：平台识别、推荐数据和页面推荐态应用。
- `packages/ruying-download/assets/app-icon.png`：从 OEM 正式桌面图标复制的品牌资源。
- `packages/ruying-download/content.test.ts`：验证页面内容、链接、语义结构、资源和关键 CSS 契约。
- `packages/ruying-download/app.test.ts`：验证 macOS、Windows 和未知平台推荐逻辑。
- `packages/ruying-download/playwright.config.ts`：本地静态预览和浏览器测试配置。
- `packages/ruying-download/download-page.e2e.ts`：验证真实页面推荐态、双下载入口、键盘焦点与响应式无溢出。
- `packages/ruying-download/README.md`：记录 HTTP-only 部署原因、固定地址和未来 HTTPS 迁移清单。

---

### Task 1: 页面内容与品牌资源

**Files:**

- Create: `packages/ruying-download/index.html`
- Create: `packages/ruying-download/assets/app-icon.png`
- Create: `packages/ruying-download/content.test.ts`

**Interfaces:**

- Consumes: `packages/desktop/icons/prod/icon.png` 正式图标和 Global Constraints 中的固定下载地址。
- Produces: `#download`, `#features`, `#install` 三个区块；`#primary-download` 主动作；`[data-platform="mac"]` 和 `[data-platform="windows"]` 下载卡片，供后续脚本和浏览器测试使用。

- [ ] **Step 1: 写内容契约测试**

创建 `packages/ruying-download/content.test.ts`，直接读取真实静态文件，不复制页面实现逻辑：

```ts
import { describe, expect, test } from "bun:test"

const root = import.meta.dir
const html = await Bun.file(`${root}/index.html`).text()

describe("ruying download page content", () => {
  test("contains the approved product structure", () => {
    expect(html).toContain("让每一次编码，都有如影相随。")
    expect(html).toContain('id="features"')
    expect(html).toContain('id="download"')
    expect(html).toContain('id="install"')
    expect(html).toContain("企业 SSO")
    expect(html).toContain("仅供长城汽车内部研发使用")
  })

  test("keeps both direct download links in HTML", () => {
    expect(html).toContain("ruying-code-desktop-mac-arm64.dmg")
    expect(html).toContain("ruying-code-desktop-win-x64.exe")
    expect(html.match(/data-download-link/g)?.length).toBe(2)
  })

  test("documents unsigned installation behavior", () => {
    expect(html).toContain("未签名")
    expect(html).toContain("SmartScreen")
    expect(html).toContain("隐私与安全性")
  })
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd packages/ruying-download && bun test content.test.ts`

Expected: FAIL，提示 `index.html` 不存在或断言内容缺失。

- [ ] **Step 3: 创建语义化 HTML 与正式图标**

复制图标：

```bash
mkdir -p packages/ruying-download/assets
cp packages/desktop/icons/prod/icon.png packages/ruying-download/assets/app-icon.png
```

创建 `index.html`，使用 `<header>`、`<main>`、`<section>` 和 `<footer>`。下载卡片必须包含以下不依赖脚本的链接结构：

```html
<a
  data-download-link
  href="http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-mac-arm64.dmg"
  >下载 macOS 版</a
>
<a
  data-download-link
  href="http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-win-x64.exe"
  >下载 Windows 版</a
>
```

首屏、三项能力、双平台下载、双平台安装说明和内部使用页脚全部使用设计文档中的已确认中文文案。通过 `<link rel="stylesheet" href="./styles.css">` 加载样式，通过 `<script type="module" src="./app.js"></script>` 加载交互。

- [ ] **Step 4: 运行内容测试并确认通过**

Run: `cd packages/ruying-download && bun test content.test.ts`

Expected: 3 tests pass。

- [ ] **Step 5: 提交内容骨架**

```bash
git add packages/ruying-download/index.html packages/ruying-download/assets/app-icon.png packages/ruying-download/content.test.ts
git commit -m "feat(web): add ruying download content"
```

---

### Task 2: 深色沉浸视觉与响应式布局

**Files:**

- Create: `packages/ruying-download/styles.css`
- Modify: `packages/ruying-download/content.test.ts`

**Interfaces:**

- Consumes: Task 1 的语义区块、类名和品牌图标。
- Produces: `--color-accent` 等页面令牌、`.hero`、`.feature-card`、`.download-card`、`:focus-visible` 与减弱动画规则。

- [ ] **Step 1: 扩展 CSS 契约测试**

在 `content.test.ts` 顶部读取 CSS，并增加测试：

```ts
const css = await Bun.file(`${root}/styles.css`).text()

test("defines responsive and accessible presentation", () => {
  expect(css).toContain("--color-accent")
  expect(css).toContain(":focus-visible")
  expect(css).toContain("prefers-reduced-motion: reduce")
  expect(css).toContain("@media (max-width: 760px)")
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd packages/ruying-download && bun test content.test.ts`

Expected: FAIL，因为 `styles.css` 尚不存在。

- [ ] **Step 3: 实现视觉系统**

创建 `styles.css`，以以下令牌为基础实现深色沉浸方向：

```css
:root {
  color-scheme: dark;
  --color-bg: #08090d;
  --color-surface: #11131a;
  --color-surface-raised: #171a23;
  --color-text: #f5f6f8;
  --color-muted: #9ca3b3;
  --color-line: rgba(255, 255, 255, 0.11);
  --color-accent: #8b5cf6;
  --color-accent-bright: #a78bfa;
  --content-width: 1180px;
}
```

首屏使用伪元素绘制紫色光晕和细网格，不加载外部背景图。下载按钮与卡片提供 hover 和 `:focus-visible` 状态；下载区与能力区在宽屏使用网格，在 `760px` 以下转为单列。加入以下减弱动画规则：

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}
```

- [ ] **Step 4: 格式化并运行内容测试**

Run: `bunx prettier --write packages/ruying-download/index.html packages/ruying-download/styles.css packages/ruying-download/content.test.ts`

Run: `cd packages/ruying-download && bun test content.test.ts`

Expected: 4 tests pass。

- [ ] **Step 5: 提交视觉实现**

```bash
git add packages/ruying-download/index.html packages/ruying-download/styles.css packages/ruying-download/content.test.ts
git commit -m "feat(web): style ruying download page"
```

---

### Task 3: 操作系统识别与推荐态

**Files:**

- Create: `packages/ruying-download/app.js`
- Create: `packages/ruying-download/app.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `#primary-download`、`#download` 和 `[data-platform]` 元素。
- Produces: `detectPlatform(userAgent: string): "mac" | "windows" | "unknown"` 与 `recommendationFor(platform)`；浏览器启动时应用主链接、按钮文案和 `.is-recommended` 卡片状态。

- [ ] **Step 1: 写平台推荐逻辑测试**

创建 `app.test.ts`：

```ts
import { describe, expect, test } from "bun:test"
import { detectPlatform, recommendationFor } from "./app.js"

describe("download recommendation", () => {
  test("detects macOS", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac")
    expect(recommendationFor("mac").label).toBe("下载 macOS 版")
  })

  test("detects Windows", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows")
    expect(recommendationFor("windows").label).toBe("下载 Windows 版")
  })

  test("falls back to platform selection", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("unknown")
    expect(recommendationFor("unknown")).toEqual({ href: "#download", label: "选择下载版本", platform: null })
  })
})
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd packages/ruying-download && bun test app.test.ts`

Expected: FAIL，提示无法导入 `app.js`。

- [ ] **Step 3: 实现纯推荐逻辑和浏览器初始化**

在 `app.js` 中导出纯函数，集中维护两个固定地址：

```js
const downloads = {
  mac: {
    href: "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-mac-arm64.dmg",
    label: "下载 macOS 版",
    platform: "mac",
  },
  windows: {
    href: "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-win-x64.exe",
    label: "下载 Windows 版",
    platform: "windows",
  },
}

export function detectPlatform(userAgent) {
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "mac"
  if (/Windows/i.test(userAgent)) return "windows"
  return "unknown"
}

export function recommendationFor(platform) {
  return downloads[platform] ?? { href: "#download", label: "选择下载版本", platform: null }
}
```

浏览器初始化从 `navigator.userAgent` 得到推荐，更新 `#primary-download` 的 `href` 和文本；推荐平台存在时给相应卡片增加 `.is-recommended`，并取消其推荐标签的隐藏状态。不要删除或重写卡片中的两个直接下载链接。

- [ ] **Step 4: 运行平台逻辑和全部单元测试**

Run: `cd packages/ruying-download && bun test`

Expected: 7 tests pass。

- [ ] **Step 5: 提交交互实现**

```bash
git add packages/ruying-download/app.js packages/ruying-download/app.test.ts packages/ruying-download/styles.css
git commit -m "feat(web): recommend ruying download"
```

---

### Task 4: 真实浏览器验收与交付检查

**Files:**

- Create: `packages/ruying-download/playwright.config.ts`
- Create: `packages/ruying-download/download-page.e2e.ts`
- Modify: `packages/ruying-download/index.html`
- Modify: `packages/ruying-download/styles.css`

**Interfaces:**

- Consumes: 完整静态页面和 Task 3 的推荐行为。
- Produces: 可重复执行的 Chromium 验收套件，以及在 1440×1000 与 390×844 视口下通过的最终页面。

- [ ] **Step 1: 配置本地静态预览与浏览器测试**

创建 `playwright.config.ts`：

```ts
import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "download-page.e2e.ts",
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "bun --port 4173 index.html",
    port: 4173,
    reuseExistingServer: true,
  },
})
```

- [ ] **Step 2: 写真实页面验收测试**

创建 `download-page.e2e.ts`，至少包含以下真实 DOM 断言：

```ts
import { expect, test } from "@playwright/test"

test("keeps both platform downloads available", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("[data-download-link]")).toHaveCount(2)
  await expect(page.getByRole("heading", { name: "让每一次编码，都有如影相随。" })).toBeVisible()
})

test("renders without horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  )
})

test("shows keyboard focus on the primary action", async ({ page }) => {
  await page.goto("/")
  await page.keyboard.press("Tab")
  await expect(page.locator(":focus-visible")).toBeVisible()
})
```

在测试中使用 `page.addInitScript` 覆盖 `navigator.userAgent`，分别验证 macOS、Windows 和 Linux 的主按钮文案、链接和推荐卡片。

- [ ] **Step 3: 运行浏览器测试并修正真实缺陷**

Run: `cd packages/ruying-download && bunx playwright test --config playwright.config.ts`

Expected: 所有 Chromium 测试通过。只修复测试揭示的页面问题，不改变已确认的结构和文案。

- [ ] **Step 4: 执行最终静态与视觉检查**

Run: `cd packages/ruying-download && bun test`

Expected: 7 tests pass。

Run: `cd packages/ruying-download && bunx playwright test --config playwright.config.ts`

Expected: 所有浏览器测试通过。

使用浏览器分别查看 `1440×1000` 和 `390×844`，确认图标清晰、紫色光晕不遮挡文字、下载区层级明确、安装说明可读且页面无横向滚动。

- [ ] **Step 5: 检查静态资源与下载地址**

Run: `cd packages/ruying-download && rg -n "https?://" index.html app.js styles.css`

Expected: 只出现两个已确认的 OSS 下载地址，不出现第三方字体、图片、脚本、接口或埋点地址。

Run: `git diff --check`

Expected: 无输出，退出码为 0。

- [ ] **Step 6: 提交浏览器验收与最终修正**

```bash
git add packages/ruying-download
git commit -m "test(web): verify ruying download page"
```
