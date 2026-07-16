# Skill 市场操作反馈修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Web 投稿入口使用可靠的基础路径链接，并让角色表单的无效操作产生明确反馈。

**Architecture:** 共享 `SkillMarketList` 同时支持 Web 链接和桌面回调，Web 选择原生链接、桌面保持回调。角色表单将空工号从静默禁用改为本地校验错误，只有进行中的请求才真正禁用主按钮。

**Tech Stack:** SolidJS、Solid Router、Bun Test、Testing Library、Vite、Nginx 静态 Web release。

## Global Constraints

- Web 链接必须包含 Vite `BASE_URL`，不能写死服务器 IP、端口或未来域名。
- 桌面端现有 `onSubmit` 回调行为保持不变。
- 空工号不能发出角色写请求，提示固定为“请输入员工工号。”。
- 只发布 Web release，不重启 API，不修改数据库和现有角色。
- 保留当前 Web release 作为原子回滚目标。

---

### Task 1: 可靠的投稿链接

**Files:**
- Modify: `packages/app/src/skill-market/list.test.tsx`
- Modify: `packages/app/src/skill-market/list.tsx`
- Modify: `packages/app/src/skill-market/styles.css`
- Modify: `packages/skill-market-web/src/app.tsx`
- Test: `packages/app/src/skill-market/list.test.tsx`

**Interfaces:**
- Consumes: 现有 `onSubmit?: () => void` 桌面回调。
- Produces: `submitHref?: string`；有链接时渲染 `<a>`，否则保留现有按钮。

- [ ] **Step 1: 写出投稿链接失败测试**

在 `renderMarket` 增加 `submitHref?: string` 参数并传给组件；新增测试：

```tsx
test("prefers a submission link while preserving callback-only actions", async () => {
  let submitted = 0
  const linked = renderMarket(
    dataSource(async () => page([communitySkill])),
    () => undefined,
    undefined,
    false,
    () => submitted++,
    "/ai-coding/ruying-code/skill-market/submissions/new",
  )
  const link = await linked.findByRole("link", { name: "投稿 Skill" })
  expect(link.getAttribute("href")).toBe("/ai-coding/ruying-code/skill-market/submissions/new")
  expect(submitted).toBe(0)
  cleanup()

  const callback = renderMarket(
    dataSource(async () => page([communitySkill])),
    () => undefined,
    undefined,
    false,
    () => submitted++,
  )
  await userEvent.click(await callback.findByRole("button", { name: "投稿 Skill" }))
  expect(submitted).toBe(1)
})
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
cd packages/app
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts src/skill-market/list.test.tsx
```

Expected: 新测试因 `submitHref` 尚未实现或找不到“投稿 Skill”链接而失败。

- [ ] **Step 3: 实现最小链接契约**

在 `SkillMarketList` 参数中增加 `submitHref?: string`，投稿区域使用：

```tsx
<Show
  when={props.submitHref}
  fallback={
    <Show when={props.onSubmit}>
      {(onSubmit) => (
        <button type="button" class="ruying-skill-market__submit" onClick={onSubmit()}>
          投稿 Skill
        </button>
      )}
    </Show>
  }
>
  {(href) => (
    <a class="ruying-skill-market__submit" href={href()}>
      投稿 Skill
    </a>
  )}
</Show>
```

为 `.ruying-skill-market__submit` 增加：

```css
display: inline-flex;
align-items: center;
justify-content: center;
box-sizing: border-box;
text-decoration: none;
```

Web 路由传入：

```tsx
<SkillMarketList
  onOpen={(key) => navigate(`/skills/${key.source}/${encodeURIComponent(key.id)}`)}
  submitHref={`${import.meta.env.BASE_URL}submissions/new`}
/>
```

- [ ] **Step 4: 运行相关测试并确认通过**

Run:

```bash
cd packages/app
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts src/skill-market/list.test.tsx
```

Expected: 7 tests pass, 0 fail。

- [ ] **Step 5: 提交投稿入口修复**

```bash
git add packages/app/src/skill-market/list.test.tsx packages/app/src/skill-market/list.tsx packages/app/src/skill-market/styles.css packages/skill-market-web/src/app.tsx
git commit -m "fix(skill-market): use reliable submission link"
```

---

### Task 2: 角色表单明确反馈

**Files:**
- Modify: `packages/skill-market-web/src/admin/roles.test.tsx`
- Modify: `packages/skill-market-web/src/admin/roles.tsx`
- Modify: `packages/skill-market-web/src/styles.css`
- Test: `packages/skill-market-web/src/admin/roles.test.tsx`

**Interfaces:**
- Consumes: 现有 `RoleAdministrationSource.assign`。
- Produces: 空工号本地错误，不调用 `assign`；请求中按钮保持禁用。

- [ ] **Step 1: 写出空工号失败测试**

新增测试：

```tsx
test("explains an empty employee ID without calling the server", async () => {
  const calls: SkillMarketControl.RoleInput[] = []
  const view = renderRoles({
    list: () => Promise.resolve([]),
    assign: (input) => {
      calls.push(input)
      return Promise.resolve(assignment(input.employeeID, input.role))
    },
    remove: () => Promise.resolve([]),
  })
  const button = view.getByRole("button", { name: "添加角色" })
  expect(button.hasAttribute("disabled")).toBe(false)
  fireEvent.click(button)
  expect((await view.findByRole("alert")).textContent).toContain("请输入员工工号。")
  expect(calls).toEqual([])
})
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
cd packages/skill-market-web
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts src/admin/roles.test.tsx
```

Expected: 按钮仍带 `disabled`，新测试失败。

- [ ] **Step 3: 实现本地校验与禁用样式**

将提交入口改为：

```ts
const target = employeeID().trim()
if (pending()) return
if (!target) return setError("请输入员工工号。")
```

按钮仅使用 `disabled={pending()}`。在 `packages/skill-market-web/src/styles.css` 增加：

```css
.market-primary-action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
```

- [ ] **Step 4: 运行 Web 浏览器测试并确认通过**

Run:

```bash
cd packages/skill-market-web
bun run test:browser
```

Expected: 32 tests pass, 0 fail。

- [ ] **Step 5: 提交角色反馈修复**

```bash
git add packages/skill-market-web/src/admin/roles.test.tsx packages/skill-market-web/src/admin/roles.tsx packages/skill-market-web/src/styles.css
git commit -m "fix(skill-market): explain unavailable actions"
```

---

### Task 3: 回归验证与 Web 上线

**Files:**
- Verify: `packages/app`
- Verify: `packages/skill-market-web`
- Deploy: `/srv/ruying-skill-market/web/releases/<release>` on `10.246.13.226:9922`

**Interfaces:**
- Consumes: Task 1 和 Task 2 的通过测试及生产构建。
- Produces: 新不可变 Web release 和可回滚的 `current` 软链。

- [ ] **Step 1: 运行完整相关测试和类型检查**

Run:

```bash
cd packages/app
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts src/skill-market/list.test.tsx
bun typecheck
cd ../skill-market-web
bun run test
bun typecheck
```

Expected: App 相关测试、Web 全部测试和两个类型检查退出 `0`。

- [ ] **Step 2: 构建并检查生产产物**

Run:

```bash
cd packages/skill-market-web
env -u VITE_SKILL_MARKET_API_URL -u VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP bun run build
test -f dist/index.html
rg -F '/ai-coding/ruying-code/skill-market/submissions/new' dist/assets/*.js
if rg -n '10\.246\.13\.226:4210' dist; then exit 1; fi
```

Expected: 构建退出 `0`，投稿基础路径存在，产物不包含旧的跨端口 API 地址。

- [ ] **Step 3: 记录回滚目标并传输候选 release**

Run:

```bash
previous=$(ssh -p 9922 -o BatchMode=yes root@10.246.13.226 'readlink -f /srv/ruying-skill-market/web/current')
stage="/tmp/ruying-skill-market-web-stage-$(git rev-parse --short HEAD)"
release=$(STAGE="$stage" bun -e 'import { stageLocalWebRelease } from "./script/release.ts"; console.log((await stageLocalWebRelease({ directory: "dist", root: process.env.STAGE, publicBasePath: "/ai-coding/ruying-code/skill-market/" })).release)')
tar -C "$stage/releases/$release" -czf "/tmp/ruying-skill-market-web-${release}.tar.gz" .
scp -P 9922 -o BatchMode=yes "/tmp/ruying-skill-market-web-${release}.tar.gz" root@10.246.13.226:/tmp/
```

Expected: `previous` 指向现有 release，`release` 是 16 位十六进制标识，传输成功。

- [ ] **Step 4: 原子安装并切换 Web release**

Run:

```bash
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 "release='$release' bash -s" <<'REMOTE'
set -euo pipefail
root=/srv/ruying-skill-market/web
target="$root/releases/$release"
temporary="$root/releases/.$release-$$.tmp"
link="$root/.current-$$.tmp"
test ! -e "$target"
install -d -o root -g root -m 0755 "$temporary"
tar -C "$temporary" -xzf "/tmp/ruying-skill-market-web-$release.tar.gz"
ROOT="$temporary" RELEASE="$release" bun -e '
  const root = process.env.ROOT
  const manifest = await Bun.file(`${root}/manifest.json`).json()
  if (manifest.release !== process.env.RELEASE) throw new Error("release identity mismatch")
  await Promise.all(manifest.files.map(async (file) => {
    const body = await Bun.file(`${root}/${file.path}`).bytes()
    const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
    if (body.byteLength !== file.size || sha256 !== file.sha256) throw new Error(`release hash mismatch: ${file.path}`)
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

该命令不修改 API release、不重启 API。

Expected: `readlink -f /srv/ruying-skill-market/web/current` 指向新 release，`nginx -t` 通过且 Nginx 为 active。

- [ ] **Step 5: 运行线上烟雾验证**

Run:

```bash
curl -fsS 'http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/skills' | rg 'assets/index-'
curl -fsS 'http://10.246.13.226:4211/v1/auth/session' | rg '^(null|\{)'
curl -fsSI 'http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/submissions/new' | rg 'HTTP/1.1 200'
```

使用浏览器 DOM 验证“投稿 Skill”为唯一链接，`href` 精确等于 `/ai-coding/ruying-code/skill-market/submissions/new`，点击后地址到达投稿页。角色空工号行为由本地真实组件测试覆盖；线上不创建或删除角色。

- [ ] **Step 6: 失败时原子回滚**

任一线上检查失败时运行：

```bash
previous_release=$(basename "$previous")
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 "previous_release='$previous_release' bash -s" <<'REMOTE'
set -euo pipefail
root=/srv/ruying-skill-market/web
link="$root/.current-rollback-$$.tmp"
test -d "$root/releases/$previous_release"
ln -s "releases/$previous_release" "$link"
mv -Tf "$link" "$root/current"
nginx -t
systemctl is-active nginx
REMOTE
```

然后重新执行 Step 5。保留失败 release 供诊断，不删除旧 release。

- [ ] **Step 7: 提交计划状态并报告**

确认 `git diff --check`、分支工作区干净、提交历史包含设计和两个修复提交；报告新 release、回滚 release、测试数量和线上验证结果。
