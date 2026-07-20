# Skill 市场内网安装 Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Web 端复制及手动展示的 Skill 安装 Prompt 只包含当前如影市场详情地址、目录返回的内网 ZIP、版本和 SHA-256，彻底移除 SkillHub/ClawHub 外网地址。

**Architecture:** 共享 App 组件继续负责 Prompt 的纯格式化与复制交互，但 Web action 将 Prompt 生成和剪贴板写入拆开，组件通过 memo 只生成一次文本。`skill-market-web` 根据当前 origin、Vite `BASE_URL`、source 和编码后的 ID 生成详情地址，并把目录详情中的 `package.url` 显式交给格式化器；服务端目录、镜像对象和来源溯源展示保持不变。

**Tech Stack:** TypeScript、SolidJS、Bun Test、Happy DOM、Playwright、Vite、Bun release script、Nginx

## Global Constraints

- Prompt 完全不包含 `sourceUrl`、SkillHub 外网详情或其他原始来源地址。
- Prompt 必须包含当前如影 Skill 市场的内网详情 URL、目录 API 返回的内网 ZIP URL、版本和 SHA-256。
- Prompt 必须包含原文：`要求：仅使用上述内网地址下载，并在安装前校验 SHA-256。`
- `installPrompt` 必须显式接收详情 URL 和下载 URL，不得回退到 `detail.publicDetailUrl` 或 `detail.sourceUrl`。
- Skill ID 进入详情路径前必须使用 `encodeURIComponent`；source 同样按路径段编码。
- 自动复制和复制失败后的只读文本域必须使用同一个已生成字符串。
- 下载 ZIP 按钮继续调用目录 `/download` 接口；桌面端安装、来源溯源 UI、目录 API、数据库和 SkillHub 全量镜像均不修改。
- 只发布 Web 内容寻址 release；不发布或重启 API，不暂停或重启 SkillHub 同步。
- 遵守仓库依赖方向：Web/App 运行时代码只依赖 Schema/Protocol，不依赖 Core/Server。
- 测试不得从仓库根目录运行；类型检查使用各 package 的 `bun typecheck`，不直接运行 `tsc`。

---

## File Structure

- `packages/app/src/skill-market/types.ts`：定义 Web action 的 `prompt(detail)` 和 `copyPrompt(value)` 边界。
- `packages/app/src/skill-market/detail.tsx`：格式化内网 Prompt，并确保复制与手动降级共用一个 memo 文本。
- `packages/app/src/skill-market/detail.test.tsx`：覆盖 Prompt 内容、外网地址排除、复制状态和失败降级一致性。
- `packages/app/src/skill-market/list.test.tsx`：更新共享列表测试中的 Web action 夹具。
- `packages/app/src/skill-market/provider.test.tsx`：更新 Provider 测试中的 Web action 夹具。
- `packages/app/src/skill-market/large-list.test.tsx`：更新大列表测试中的 Web action 夹具。
- `packages/skill-market-web/src/runtime-config.ts`：生成基于当前站点和部署基础路径的详情 URL。
- `packages/skill-market-web/src/runtime-config.test.ts`：验证基础路径及路径段编码。
- `packages/skill-market-web/src/app.tsx`：组装最终 Prompt，并把剪贴板函数限制为只接收字符串。
- `packages/skill-market-web/e2e/market.e2e.ts`：从用户点击到剪贴板验证完整 Prompt 数据流。

### Task 1: 共享 Prompt 与 Web action 边界

**Files:**
- Modify: `packages/app/src/skill-market/types.ts`
- Modify: `packages/app/src/skill-market/detail.tsx`
- Test: `packages/app/src/skill-market/detail.test.tsx`
- Test fixture: `packages/app/src/skill-market/list.test.tsx`
- Test fixture: `packages/app/src/skill-market/provider.test.tsx`
- Test fixture: `packages/app/src/skill-market/large-list.test.tsx`

**Interfaces:**
- Consumes: `SkillMarket.Detail`，以及调用方显式提供的 `{ readonly detailUrl: string; readonly downloadUrl: string }`。
- Produces: `installPrompt(detail, links): string`；Web action `prompt(detail): string`；Web action `copyPrompt(value: string): Promise<void>`。

- [ ] **Step 1: 把 Prompt 内容和两条复制路径改成新行为的失败测试**

在 `packages/app/src/skill-market/detail.test.tsx` 的详情夹具中保留外网字段，并把它们明确改为两个需要排除的域名：

```ts
sourceUrl: "https://clawhub.ai/example/code-review",
publicDetailUrl: "https://skillhub.cn/skills/code-review",
```

在夹具下方增加唯一的期望文本：

```ts
const expectedPrompt = `请安装并使用这个 Skill：Code Review
内网详情：http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/skills/skillhub/code-review
内网下载：https://oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/app-platform-test/ai-coding/ruying-code/skill-market-test/packages/${"a".repeat(64)}.zip
版本：1.2.0
SHA-256：${"a".repeat(64)}
要求：仅使用上述内网地址下载，并在安装前校验 SHA-256。`
```

增加纯格式化测试：

```ts
test("formats an internal-only install prompt", () => {
  const value = installPrompt(detail, {
    detailUrl:
      "http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/skills/skillhub/code-review",
    downloadUrl: `https://oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/app-platform-test/ai-coding/ruying-code/skill-market-test/packages/${"a".repeat(64)}.zip`,
  })

  expect(value).toBe(expectedPrompt)
  expect(value).not.toContain("skillhub.cn")
  expect(value).not.toContain("clawhub.ai")
  expect(value).not.toContain(detail.sourceUrl)
  expect(value).not.toContain(detail.publicDetailUrl)
})
```

把首个 Web action 测试改为记录最终字符串：

```ts
const view = renderDetail(source(), {
  kind: "web",
  prompt: () => expectedPrompt,
  copyPrompt: async (value) => {
    copied.push(value)
  },
  download: async (value) => {
    downloaded.push(value.package.url)
  },
})
```

并把断言改成：

```ts
expect(copied).toEqual([expectedPrompt])
expect(downloaded).toEqual([detail.package.url])
```

在“复制成功”测试 action 中加入：

```ts
prompt: () => expectedPrompt,
```

把“自动复制失败”测试改为捕获复制入参，并断言文本域与它完全相同：

```ts
const copied: string[] = []
const view = renderDetail(source(), {
  kind: "web",
  prompt: () => expectedPrompt,
  copyPrompt: (value) => {
    copied.push(value)
    return denied
  },
  download: async () => undefined,
})

await view.findByRole("heading", { name: detail.name, level: 1 })
await userEvent.click(view.getByRole("button", { name: "复制安装 Prompt" }))
expect((await view.findByRole("alert")).textContent).toContain("自动复制失败")
expect(copied).toEqual([expectedPrompt])
expect((view.getByRole("textbox", { name: "安装 Prompt" }) as HTMLTextAreaElement).value).toBe(
  expectedPrompt,
)
```

- [ ] **Step 2: 运行目标测试，确认旧接口和旧 Prompt 失败**

Run from `packages/app`:

```bash
bun test --conditions=browser \
  --preload ./happydom.ts \
  --preload ./solid-test-preload.ts \
  ./src/skill-market/detail.test.tsx
```

Expected: FAIL；错误应显示 `installPrompt` 参数/输出与新断言不符，且 Web action 尚无 `prompt` 边界。

- [ ] **Step 3: 修改 Web action 类型和纯 Prompt 格式化器**

把 `packages/app/src/skill-market/types.ts` 中 Web 分支改为：

```ts
export type SkillMarketActions =
  | {
      kind: "web"
      prompt: (detail: SkillMarket.Detail) => string
      copyPrompt: (value: string) => Promise<void>
      download: (detail: SkillMarket.Detail) => Promise<void>
    }
  | {
      kind: "desktop"
      install: (input: SkillMarket.InstallRequest) => Promise<SkillMarket.OperationResult>
      update: (input: SkillMarket.InstallRequest) => Promise<SkillMarket.OperationResult>
      uninstall: (key: SkillKey) => Promise<void>
      refresh: (key: SkillKey) => Promise<void>
    }
```

把 `packages/app/src/skill-market/detail.tsx` 的 Solid import 改为：

```ts
import { For, Show, createMemo, createSignal } from "solid-js"
```

把格式化器改为：

```ts
export function installPrompt(
  detail: SkillMarket.Detail,
  links: { readonly detailUrl: string; readonly downloadUrl: string },
) {
  return `请安装并使用这个 Skill：${detail.name}
内网详情：${links.detailUrl}
内网下载：${links.downloadUrl}
版本：${detail.version}
SHA-256：${detail.package.sha256}
要求：仅使用上述内网地址下载，并在安装前校验 SHA-256。`
}
```

函数中不得读取 `detail.sourceUrl` 或 `detail.publicDetailUrl`。

- [ ] **Step 4: 让详情组件只生成一次 Prompt，并复用到复制和降级文本域**

把 `WebDetailActions` 开头和 `copy` 改为：

```ts
function WebDetailActions(props: { detail: SkillMarket.Detail; actions: SkillMarketActions }) {
  const [copyState, setCopyState] = createSignal<"idle" | "copying" | "copied" | "failed">("idle")
  const prompt = createMemo(() => (props.actions.kind === "web" ? props.actions.prompt(props.detail) : ""))
  const copy = async () => {
    if (props.actions.kind !== "web" || copyState() === "copying") return
    setCopyState("copying")
    await props.actions.copyPrompt(prompt()).then(
      () => setCopyState("copied"),
      () => setCopyState("failed"),
    )
  }
```

把失败文本域的值改为：

```tsx
<textarea
  class="ruying-skill-market__copy-manual"
  aria-label="安装 Prompt"
  readOnly
  value={prompt()}
/>
```

- [ ] **Step 5: 更新其余共享测试的 Web action 夹具**

在 `packages/app/src/skill-market/detail.test.tsx`、`list.test.tsx`、`provider.test.tsx` 和
`large-list.test.tsx` 的每一个 `{ kind: "web", ... }` action 中加入：

```ts
prompt: () => expectedPrompt,
```

`detail.test.tsx` 使用 Step 1 的 `expectedPrompt`；其他三个文件不检查 Prompt 内容，使用：

```ts
prompt: () => "prompt",
```

所有 `copyPrompt` 夹具都只接收字符串，不再读取 `SkillMarket.Detail` 字段。

- [ ] **Step 6: 运行共享 Skill 市场测试和类型检查**

Run from `packages/app`:

```bash
bun test --conditions=browser \
  --preload ./happydom.ts \
  --preload ./solid-test-preload.ts \
  ./src/skill-market/detail.test.tsx \
  ./src/skill-market/list.test.tsx \
  ./src/skill-market/provider.test.tsx \
  ./src/skill-market/large-list.test.tsx
bun typecheck
```

Expected: 所列测试全部 PASS，`bun typecheck` 退出 `0`。

- [ ] **Step 7: 提交共享边界改动**

Run from repository worktree root:

```bash
git add \
  packages/app/src/skill-market/types.ts \
  packages/app/src/skill-market/detail.tsx \
  packages/app/src/skill-market/detail.test.tsx \
  packages/app/src/skill-market/list.test.tsx \
  packages/app/src/skill-market/provider.test.tsx \
  packages/app/src/skill-market/large-list.test.tsx
git commit -m "fix(app): require internal install prompt links"
```

Expected: 生成一个只包含共享 App 及测试改动的 commit。

### Task 2: Web 内网详情地址与完整复制数据流

**Files:**
- Modify: `packages/skill-market-web/src/runtime-config.ts`
- Test: `packages/skill-market-web/src/runtime-config.test.ts`
- Modify: `packages/skill-market-web/src/app.tsx`
- Test: `packages/skill-market-web/e2e/market.e2e.ts`

**Interfaces:**
- Consumes: Task 1 的 `installPrompt(detail, links)`、`SkillMarketActions.prompt(detail)` 和 `copyPrompt(value)`。
- Produces: `skillDetailUrl(pageOrigin, basePath, skill): string`，以及只向剪贴板传最终字符串的 Web action。

- [ ] **Step 1: 为当前站点详情 URL 写失败测试**

把 `packages/skill-market-web/src/runtime-config.test.ts` import 改为：

```ts
import { resolveSkillMarketRuntime, skillDetailUrl } from "./runtime-config"
```

增加：

```ts
test("builds an encoded skill detail URL under the deployed base path", () => {
  expect(
    skillDetailUrl(
      "http://10.246.13.226:4211",
      "/ai-coding/ruying-code/skill-market/",
      { source: "skillhub", id: "name with/slash" },
    ),
  ).toBe(
    "http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/skills/skillhub/name%20with%2Fslash",
  )
})
```

- [ ] **Step 2: 运行测试，确认 helper 尚不存在**

Run from `packages/skill-market-web`:

```bash
bun test src/runtime-config.test.ts
```

Expected: FAIL with `skillDetailUrl` 未导出或不是函数。

- [ ] **Step 3: 实现基础路径安全的详情 URL helper**

在 `packages/skill-market-web/src/runtime-config.ts` 末尾增加：

```ts
export function skillDetailUrl(
  pageOrigin: string,
  basePath: string,
  skill: { readonly source: string; readonly id: string },
) {
  const base = new URL(basePath.endsWith("/") ? basePath : `${basePath}/`, pageOrigin)
  return new URL(
    `skills/${encodeURIComponent(skill.source)}/${encodeURIComponent(skill.id)}`,
    base,
  ).href
}
```

Run from `packages/skill-market-web`:

```bash
bun test src/runtime-config.test.ts
```

Expected: PASS。

- [ ] **Step 4: 让 Web app 显式组装内网 Prompt**

把 `packages/skill-market-web/src/app.tsx` 的 runtime-config import 改为：

```ts
import { resolveSkillMarketRuntime, skillDetailUrl } from "./runtime-config"
```

把 Web actions 改为：

```ts
const actions: SkillMarketActions = {
  kind: "web",
  prompt: (detail) =>
    installPrompt(detail, {
      detailUrl: skillDetailUrl(window.location.origin, import.meta.env.BASE_URL, detail),
      downloadUrl: detail.package.url,
    }),
  copyPrompt: async (value) => {
    if (await copyText(value)) return
    throw new Error("Skill market install prompt could not be copied")
  },
  download: async (detail) => {
    const target = await source.download?.({ source: detail.source, id: detail.id })
    if (!target) throw new Error("Skill market download endpoint is unavailable")
    window.location.assign(target.url)
  },
}
```

这里不得传入 `detail.sourceUrl` 或 `detail.publicDetailUrl`；下载按钮逻辑保持原样。

- [ ] **Step 5: 强化浏览器端到端剪贴板断言**

在 `packages/skill-market-web/e2e/market.e2e.ts` 首个测试中，把只检查 `SHA-256` 的断言替换为：

```ts
await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("SHA-256")
const clipboard = await page.evaluate(() => navigator.clipboard.readText())
expect(clipboard).toContain(`内网详情：${page.url()}`)
expect(clipboard).toContain("内网下载：https://downloads.example.com/code-review.zip")
expect(clipboard).toContain("要求：仅使用上述内网地址下载，并在安装前校验 SHA-256。")
expect(clipboard).not.toContain("skillhub.cn")
expect(clipboard).not.toContain("clawhub.ai")
```

- [ ] **Step 6: 运行 Web 单元、浏览器、E2E 和类型检查**

Run from `packages/skill-market-web`:

```bash
bun run test
bun typecheck
bun run test:e2e -- --grep "searches, filters, deep-links, copies a prompt"
```

Expected: Web 单元/浏览器测试全部 PASS，类型检查退出 `0`，目标 Playwright 测试 PASS。

- [ ] **Step 7: 提交 Web 运行时改动**

Run from repository worktree root:

```bash
git add \
  packages/skill-market-web/src/runtime-config.ts \
  packages/skill-market-web/src/runtime-config.test.ts \
  packages/skill-market-web/src/app.tsx \
  packages/skill-market-web/e2e/market.e2e.ts
git commit -m "fix(skill-market): copy internal install links"
```

Expected: 生成一个只包含 Web 地址生成、组装和 E2E 断言的 commit。

### Task 3: 回归、发布和生产验收

**Files:**
- Verify: `packages/app`
- Verify/build/release: `packages/skill-market-web`
- Deploy target: `root@10.246.13.226:9922:/srv/ruying-skill-market/web`

**Interfaces:**
- Consumes: Task 1 和 Task 2 已提交的代码，现有 `publishWebRelease` 与 `stageLocalWebRelease`。
- Produces: 已推送的 Git 分支、OSS `current.json` 指向的新 Web release、Nginx 原子切换后的生产 Web。

- [ ] **Step 1: 运行完整相关回归**

Run from `packages/app`:

```bash
bun test --conditions=browser \
  --preload ./happydom.ts \
  --preload ./solid-test-preload.ts \
  ./src
bun typecheck
```

Run from `packages/skill-market-web`:

```bash
bun run test
bun typecheck
bun run test:e2e
```

Expected: 全部命令退出 `0`；没有 App 或 Web 回归。

- [ ] **Step 2: 构建生产 Web 并检查不存在硬编码外网 Prompt 文案**

Run from `packages/skill-market-web`:

```bash
env -u VITE_SKILL_MARKET_API_URL -u VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP bun run build
test -f dist/index.html
rg -F '仅使用上述内网地址下载，并在安装前校验 SHA-256' dist/assets/*.js
if rg -F '详情：https://skillhub.cn/' dist/assets/*.js; then exit 1; fi
if rg -F '来源：https://clawhub.ai/' dist/assets/*.js; then exit 1; fi
```

Expected: 构建退出 `0`，新要求文案存在，旧 Prompt 的两个外网行不存在。

- [ ] **Step 3: 检查改动范围并推送分支**

Run from repository worktree root:

```bash
git status --short
git diff --check origin/dev...HEAD
git log --oneline origin/dev..HEAD
git push origin skillhub-full-mirror
```

Expected: 工作树干净，diff check 无输出；设计、计划和两个实现 commit 均在远端
`skillhub-full-mirror` 分支。

- [ ] **Step 4: 生成内容寻址 release、记录回滚目标并上传候选包**

Run from `packages/skill-market-web`:

```bash
previous=$(ssh -p 9922 -o BatchMode=yes root@10.246.13.226 \
  'readlink -f /srv/ruying-skill-market/web/current')
stage="/tmp/ruying-skill-market-web-stage-$(git rev-parse --short HEAD)"
release=$(STAGE="$stage" bun -e '
  import { stageLocalWebRelease } from "./script/release.ts"
  console.log((await stageLocalWebRelease({
    directory: "dist",
    root: process.env.STAGE,
    publicBasePath: "/ai-coding/ruying-code/skill-market/",
  })).release)
')
test "${#release}" -eq 16
candidate=$(mktemp -d "/tmp/ruying-skill-market-web-candidate-$(git rev-parse --short HEAD)-XXXXXX")
mkdir -p "$candidate/script"
bun build script/release.ts --target bun --outfile "$candidate/script/release.js"
cp -R dist "$candidate/dist"
tar -C "$candidate" -czf "$candidate.tar.gz" script/release.js dist
tar -C "$stage/releases/$release" -czf "/tmp/ruying-skill-market-web-$release.tar.gz" .
scp -P 9922 -o BatchMode=yes \
  "$candidate.tar.gz" \
  "/tmp/ruying-skill-market-web-$release.tar.gz" \
  root@10.246.13.226:/tmp/
```

Expected: `previous` 是现行 release 绝对路径，`release` 是 16 位十六进制内容标识，两个归档传输成功。

- [ ] **Step 5: 用服务账号发布 OSS 指针，再由 root 原子切换本机 Web**

Run from `packages/skill-market-web`，沿用 Step 4 的 shell 变量：

```bash
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 \
  "release='$release' candidate='$candidate' bash -s" <<'REMOTE'
set -euo pipefail
extract="$candidate.remote"
install -d -o ruying-market -g ruying-market -m 0750 "$extract"
tar -C "$extract" -xzf "$candidate.tar.gz"
publish_output=$(
  sudo -u ruying-market env CANDIDATE="$extract" bash -c '
    set -a
    source /etc/ruying-skill-market/market.env
    set +a
    unset SKILL_MARKET_WEB_LOCAL_ROOT
    cd "$CANDIDATE"
    exec /usr/local/bin/bun script/release.js
  '
)
printf '%s\n' "$publish_output"
printf '%s\n' "$publish_output" | grep -F "Published Skill market Web release $release "

root=/srv/ruying-skill-market/web
target="$root/releases/$release"
temporary="$root/releases/.$release-$$.tmp"
link="$root/.current-$$.tmp"
test ! -e "$target"
install -d -o root -g root -m 0755 "$temporary"
tar -C "$temporary" -xzf "/tmp/ruying-skill-market-web-$release.tar.gz"
ROOT="$temporary" RELEASE="$release" /usr/local/bin/bun -e '
  const root = process.env.ROOT
  const manifest = await Bun.file(`${root}/manifest.json`).json()
  if (manifest.release !== process.env.RELEASE) throw new Error("release identity mismatch")
  await Promise.all(manifest.files.map(async (file) => {
    const body = await Bun.file(`${root}/${file.path}`).bytes()
    const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
    if (body.byteLength !== file.size || sha256 !== file.sha256)
      throw new Error(`release hash mismatch: ${file.path}`)
  }))
'
mv "$temporary" "$target"
ln -s "releases/$release" "$link"
mv -Tf "$link" "$root/current"
nginx -t
systemctl is-active nginx
readlink -f "$root/current"
REMOTE
```

Expected: OSS 输出确认发布同一个 `release`；`/srv/ruying-skill-market/web/current` 指向新
release；Nginx 配置有效且服务仍为 active。该步骤不修改 API release，也不重启 API 或同步 timer。

- [ ] **Step 6: 在生产详情页验证剪贴板、目录包和 SHA-256 一致**

Run from `packages/skill-market-web`:

```bash
bun -e '
  import { chromium } from "@playwright/test"
  const id = "backup-global-cognitive-brain-20260316-100703"
  const origin = "http://10.246.13.226:4211"
  const detailUrl =
    `${origin}/ai-coding/ruying-code/skill-market/skills/skillhub/${encodeURIComponent(id)}`
  const browser = await chromium.launch()
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] })
  const page = await context.newPage()
  await page.goto(detailUrl)
  await page.getByRole("heading", { level: 1 }).waitFor()
  await page.getByRole("button", { name: "复制安装 Prompt" }).click()
  await page.getByRole("button", { name: "已复制" }).waitFor()
  const prompt = await page.evaluate(() => navigator.clipboard.readText())
  const detailResponse = await context.request.get(
    `${origin}/v1/catalog/skills/skillhub/${encodeURIComponent(id)}`,
  )
  const downloadResponse = await context.request.get(
    `${origin}/v1/catalog/skills/skillhub/${encodeURIComponent(id)}/download`,
  )
  if (!detailResponse.ok() || !downloadResponse.ok()) throw new Error("catalog verification request failed")
  const detail = await detailResponse.json()
  const download = await downloadResponse.json()
  if (prompt.includes("skillhub.cn") || prompt.includes("clawhub.ai"))
    throw new Error("external URL leaked into install prompt")
  if (!prompt.includes(`内网详情：${detailUrl}`)) throw new Error("internal detail URL missing")
  if (!prompt.includes(`内网下载：${detail.package.url}`)) throw new Error("internal package URL missing")
  if (!prompt.includes(`SHA-256：${detail.package.sha256}`)) throw new Error("package SHA-256 missing")
  if (download.url !== detail.package.url || download.sha256 !== detail.package.sha256)
    throw new Error("catalog download metadata mismatch")
  if (!prompt.includes("要求：仅使用上述内网地址下载，并在安装前校验 SHA-256。"))
    throw new Error("internal-only instruction missing")
  await browser.close()
  console.log("production internal install prompt verified")
'
```

Expected: 输出 `production internal install prompt verified`。报告中的 Skill 复制文本不含
`skillhub.cn` 或 `clawhub.ai`，内网 ZIP 与 `/download` 的 SHA-256 一致。

- [ ] **Step 7: 记录部署结果和回滚命令**

记录 Step 4 的 `previous` 和 `release`。若 Step 6 失败，立即运行：

```bash
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 \
  "previous='$previous' bash -s" <<'REMOTE'
set -euo pipefail
test -d "$previous"
root=/srv/ruying-skill-market/web
link="$root/.rollback-$$.tmp"
ln -s "releases/$(basename "$previous")" "$link"
mv -Tf "$link" "$root/current"
nginx -t
systemctl reload nginx
REMOTE
```

再用 Step 4 上传并在服务器保留的 release bundle 恢复 OSS `current.json`：

```bash
previous_release=$(basename "$previous")
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 \
  "previous_release='$previous_release' candidate='$candidate' bash -s" <<'REMOTE'
set -euo pipefail
extract="$candidate.remote"
test -f "$extract/script/release.js"
sudo -u ruying-market env \
  CANDIDATE="$extract" \
  ROLLBACK_RELEASE="$previous_release" \
  bash -c '
    set -a
    source /etc/ruying-skill-market/market.env
    set +a
    unset SKILL_MARKET_WEB_LOCAL_ROOT
    export SKILL_MARKET_WEB_ROLLBACK_RELEASE="$ROLLBACK_RELEASE"
    cd "$CANDIDATE"
    exec /usr/local/bin/bun script/release.js
  '
REMOTE
```

Expected rollback output contains `Rolled back Skill market Web release $previous_release`；不得删除新内容寻址对象。

Expected: 正常发布时无需执行回滚；最终交付记录包含 Git commit、Web release、生产 URL 和生产剪贴板验证结果。
