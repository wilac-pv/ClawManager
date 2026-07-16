# Skill 市场 Admin 自审权限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许 Admin 审核包括自己投稿在内的所有 Skill，同时继续禁止普通 Reviewer 自审，并保留完整审核与审计记录。

**Architecture:** 服务端 `SkillMarketSecurity.requireReviewTarget` 是唯一授权边界，Admin 在投稿人检查前获得放行，Reviewer 继续执行自审禁止规则。Web 审核页只用会话派生的 `admin` 标志改善交互，实际决定仍由服务端重新授权；数据库结构和审核事务保持不变。

**Tech Stack:** TypeScript、Bun、Effect Schema、SQLite、SolidJS、TanStack Solid Query、Playwright、Nginx、systemd。

## Global Constraints

- Admin 可以审核任何 `pending_review` 投稿，包括自己的投稿。
- Reviewer 可以审核其他员工的投稿，但不能审核自己的投稿。
- 没有 Reviewer 或 Admin 角色的用户不能访问审核接口。
- 状态、乐观并发版本、审核意见和风险确认规则保持不变。
- 成功决定继续原子写入 `reviews`、`submissions`、必要的 `publish_jobs` 和 `audit_events`。
- 不新增数据库迁移、角色、权限字段或二次复核流程。
- 测试不能从仓库根目录运行；类型检查使用各包的 `bun typecheck`。
- 不直接编辑生成代码。

---

### Task 1: 服务端 Admin 自审授权与审计

**Files:**
- Modify: `packages/skill-market-server/test/security.test.ts:14-42`
- Modify: `packages/skill-market-server/test/moderation.test.ts:15-65`
- Modify: `packages/skill-market-server/src/security.ts:131-141`

**Interfaces:**
- Consumes: `Principal.session.roles`, `Principal.session.user.employeeID`, 投稿人的 `ownerEmployeeID`。
- Produces: `requireReviewTarget(principal, ownerEmployeeID): Principal`，Admin 对任意投稿返回原 principal，Reviewer 自审抛出 `SkillMarketSecurityError("forbidden", ...)`。

- [ ] **Step 1: 写安全矩阵失败测试**

在 `packages/skill-market-server/test/security.test.ts` 的 Admin 断言中加入：

```ts
const admin = fixture.security.requireSession(credentials("admin"))
expect(fixture.security.requireReviewer(admin)).toBe(admin)
expect(fixture.security.requireAdmin(admin)).toBe(admin)
expect(fixture.security.requireReviewTarget(admin, "admin")).toBe(admin)
```

保留现有 Reviewer 自审断言：

```ts
expect(() => fixture.security.requireReviewTarget(reviewer, "reviewer")).toThrow("own submission")
```

- [ ] **Step 2: 写 Admin 自审事务失败测试**

在 `packages/skill-market-server/test/moderation.test.ts` 新增独立测试，并从并发测试中删除“Admin 自审必须 forbidden”的旧断言：

```ts
test("allows Admin to approve an owned submission with review and audit records", async () => {
  const fixture = await moderationFixture()
  const submissionID = seedSubmission(fixture, { owner: "admin", risk: "safe", salt: "admin-own" })
  const moderation = createModeration({
    database: fixture.database,
    security: fixture.security,
    now: () => fixture.clock.value,
  })

  const result = moderation.decide(fixture.admin, submissionID, {
    expectedVersion: 2,
    decision: "approve",
    comment: "Admin reviewed the package",
  })

  expect(result).toMatchObject({ id: submissionID, status: "publishing", version: 3 })
  expect(rowCount(fixture, "reviews")).toBe(1)
  expect(rowCount(fixture, "publish_jobs")).toBe(1)
  expect(
    fixture.database.connection
      .query<{ reviewer_employee_id: string; decision: string; comment: string }, []>(
        "SELECT reviewer_employee_id, decision, comment FROM reviews",
      )
      .get(),
  ).toEqual({
    reviewer_employee_id: "admin",
    decision: "approve",
    comment: "Admin reviewed the package",
  })
  expect(
    fixture.database.connection
      .query<{ action: string; actor_employee_id: string; before_json: string; after_json: string }, []>(
        "SELECT action, actor_employee_id, before_json, after_json FROM audit_events",
      )
      .get(),
  ).toEqual({
    action: "review-approved",
    actor_employee_id: "admin",
    before_json: JSON.stringify({ status: "pending_review", version: 2 }),
    after_json: JSON.stringify({ status: "publishing", version: 3 }),
  })

  fixture.database.close()
})
```

- [ ] **Step 3: 运行聚焦测试并确认 RED**

Run from `packages/skill-market-server`:

```bash
bun test test/security.test.ts test/moderation.test.ts
```

Expected: Admin 自审安全矩阵和事务测试均因 `reviewers cannot review their own submission` 失败；Reviewer 自审测试仍通过。

- [ ] **Step 4: 实现最小服务端授权变化**

将 `packages/skill-market-server/src/security.ts` 的 `requireReviewTarget` 改为：

```ts
requireReviewTarget(principal: Principal, ownerEmployeeID: string) {
  this.requireReviewer(principal)
  if (principal.session.roles.includes("admin")) return principal
  if (principal.session.user.employeeID !== ownerEmployeeID) return principal
  throw new SkillMarketSecurityError("forbidden", "reviewers cannot review their own submission")
}
```

- [ ] **Step 5: 运行聚焦测试并确认 GREEN**

Run from `packages/skill-market-server`:

```bash
bun test test/security.test.ts test/moderation.test.ts
bun typecheck
```

Expected: 两个测试文件 `0 fail`，类型检查退出 `0`；Reviewer 自审拒绝和 Admin 自审审核/发布/审计全部通过。

- [ ] **Step 6: 提交服务端变化**

```bash
git add packages/skill-market-server/src/security.ts packages/skill-market-server/test/security.test.ts packages/skill-market-server/test/moderation.test.ts
git commit -m "feat(skill-market): allow admin self-review"
```

---

### Task 2: Web 审核页按 Admin 角色放开自审

**Files:**
- Modify: `packages/skill-market-web/src/admin/review.test.tsx:12-20`
- Modify: `packages/skill-market-web/src/admin/review.test.tsx:220-248`
- Modify: `packages/skill-market-web/src/admin/review.tsx:35-42`
- Modify: `packages/skill-market-web/src/admin/review.tsx:104-111`

**Interfaces:**
- Consumes: `ModerationReviewProps.actor: string` 和 `ModerationReviewProps.admin?: boolean`。
- Produces: `selfReview(): boolean`，仅当投稿人等于当前用户且用户不是 Admin 时返回 `true`。

- [ ] **Step 1: 保留 Reviewer 自审测试并写 Admin 自审失败测试**

将现有测试名称明确为 Reviewer，并新增 Admin 测试：

```ts
test("disables Reviewer self-review with a server-identity explanation", async () => {
  const view = renderReview(source(detail()), "E000001")

  expect(await view.findByText("不能审核自己的投稿")).toBeTruthy()
  expect(view.getByRole("button", { name: "提交审核决定" }).hasAttribute("disabled")).toBe(true)
})

test("allows Admin to review an owned submission", async () => {
  const calls: SkillMarketControl.DecisionInput[] = []
  const fixture = { ...detail(), risk: "safe" as const }
  const view = renderReview(
    source(fixture, (_id, input) => {
      calls.push(input)
      return Promise.resolve({ ...fixture, status: "publishing", version: 4 })
    }),
    "E000001",
    { admin: true },
  )

  await view.findByRole("heading", { name: "审核 Safe Skill" })
  expect(view.queryByText("不能审核自己的投稿")).toBeNull()
  fireEvent.click(view.getByLabelText("通过"))
  fireEvent.input(view.getByLabelText("审核意见"), { target: { value: "Admin reviewed the package" } })
  fireEvent.click(view.getByRole("button", { name: "提交审核决定" }))

  await waitFor(() => expect(calls).toEqual([{ expectedVersion: 3, decision: "approve", comment: "Admin reviewed the package" }]))
})
```

放宽测试辅助函数的第三个参数，使 Admin 测试不必提供无关运营操作：

```ts
admin?: { admin: boolean; operations?: ModerationOperationsSource }
```

- [ ] **Step 2: 运行 Web 聚焦测试并确认 RED**

Run from `packages/skill-market-web`:

```bash
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts src/admin/review.test.tsx
```

Expected: Admin 自审测试失败，因为页面仍显示禁止提示且提交按钮 disabled；Reviewer 测试通过。

- [ ] **Step 3: 实现最小 Web 角色判断**

在 `packages/skill-market-web/src/admin/review.tsx` 中把共享的自审状态改为：

```ts
const selfReview = () => detail().owner.employeeID === props.actor && !props.admin
```

保持 `submit`、`fieldset`、审核意见、风险确认和提交按钮继续统一使用 `selfReview()`；不要在其他位置复制权限表达式。

- [ ] **Step 4: 运行 Web 聚焦测试并确认 GREEN**

Run from `packages/skill-market-web`:

```bash
bun test --conditions=browser --preload ./happydom.ts --preload ./solid-test-preload.ts src/admin/review.test.tsx
bun typecheck
```

Expected: `review.test.tsx` 全部通过且类型检查退出 `0`；Admin 自审可提交，Reviewer 自审仍禁用。

- [ ] **Step 5: 提交 Web 变化**

```bash
git add packages/skill-market-web/src/admin/review.tsx packages/skill-market-web/src/admin/review.test.tsx
git commit -m "feat(skill-market): enable admin self-review ui"
```

---

### Task 3: 合并结果全量验证与不可变产物

**Files:**
- Verify: `packages/skill-market-server/`
- Verify: `packages/skill-market-web/`
- Create generated artifact: `/tmp/ruying-skill-market-server-<git-sha>/`
- Create generated artifact: `/tmp/ruying-skill-market-web-<release>/`

**Interfaces:**
- Consumes: Task 1 和 Task 2 的提交。
- Produces: 通过哈希校验的 API tarball 与内容寻址 Web tarball。

- [ ] **Step 1: 运行 Server 全包验证**

Run from `packages/skill-market-server`:

```bash
bun test
bun typecheck
```

Expected: 全部 Server 测试 `0 fail`，类型检查退出 `0`。

- [ ] **Step 2: 运行 Web 全包与桌面 E2E 验证**

Run from `packages/skill-market-web`:

```bash
bun run test
bun typecheck
bun run test:e2e -- --project=desktop-light
```

Expected: Web 单元/组件测试和 9 条 desktop-light E2E 全部通过，类型检查退出 `0`。

- [ ] **Step 3: 构建 API 与 Web 生产产物**

Run from repository root:

```bash
set -euo pipefail
sha=$(git rev-parse HEAD)
api_stage="/tmp/ruying-skill-market-server-$sha"
web_stage="/tmp/ruying-skill-market-web-stage-$sha"
rm -rf "$api_stage" "$web_stage"

cd packages/skill-market-server
bun run build:release "$api_stage"
cd ../skill-market-web
env -u VITE_SKILL_MARKET_API_URL -u VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP bun run build
release=$(STAGE="$web_stage" bun -e 'import { stageLocalWebRelease } from "./script/release.ts"; console.log((await stageLocalWebRelease({ directory: "dist", root: process.env.STAGE, publicBasePath: "/ai-coding/ruying-code/skill-market/" })).release)')

tar -C "$api_stage" -czf "/tmp/ruying-skill-market-server-$sha.tar.gz" .
tar -C "$web_stage/releases/$release" -czf "/tmp/ruying-skill-market-web-$release.tar.gz" .
printf 'sha=%s\nweb_release=%s\n' "$sha" "$release"
```

Expected: API SHA 为当前提交，Web release 为 16 位十六进制值，两个 tarball 均非空。

- [ ] **Step 4: 检查产物契约和工作区**

```bash
test -s "/tmp/ruying-skill-market-server-$sha.tar.gz"
test -s "/tmp/ruying-skill-market-web-$release.tar.gz"
test -f "$api_stage/packages/skill-market-server/src/server.ts"
test -f "$web_stage/releases/$release/index.html"
rg -F '/ai-coding/ruying-code/skill-market/' "$web_stage/releases/$release/index.html"
git diff --check
git status --short
```

Expected: 所有检查退出 `0`；Git 只保留用户已有的 `.superpowers/brainstorm/` 未跟踪目录，不包含实施产生的未提交文件。

---

### Task 4: 受保护的 API 与 Web 线上发布

**Files:**
- Deploy generated API/Web artifacts; do not edit repository files.
- Preserve: `/etc/ruying-skill-market/market.env`
- Preserve: `/var/lib/ruying-skill-market/market.db`

**Interfaces:**
- Consumes: Task 3 的 `sha`、`release`、tarball，服务器 `10.246.13.226:9922`。
- Produces: `/srv/ruying-skill-market/current -> releases/<sha>` 与 `/srv/ruying-skill-market/web/current -> releases/<release>`。

- [ ] **Step 1: 记录回滚点并传输产物**

```bash
previous_api=$(ssh -p 9922 -o BatchMode=yes root@10.246.13.226 'readlink -f /srv/ruying-skill-market/current')
previous_web=$(ssh -p 9922 -o BatchMode=yes root@10.246.13.226 'readlink -f /srv/ruying-skill-market/web/current')
scp -q -P 9922 -o BatchMode=yes "/tmp/ruying-skill-market-server-$sha.tar.gz" root@10.246.13.226:/tmp/
scp -q -P 9922 -o BatchMode=yes "/tmp/ruying-skill-market-web-$release.tar.gz" root@10.246.13.226:/tmp/
printf 'previous_api=%s\nprevious_web=%s\n' "$previous_api" "$previous_web"
```

Expected: 两个回滚路径均存在，传输成功且不打印环境变量、Cookie 或 OSS 凭据。

- [ ] **Step 2: 安装并预检不可变 API release**

```bash
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 "sha='$sha' bash -s" <<'REMOTE'
set -euo pipefail
root=/srv/ruying-skill-market
target="$root/releases/$sha"
temporary="$root/releases/.$sha-$$.tmp"
test ! -e "$target"
install -d -o root -g root -m 0755 "$temporary"
tar -C "$temporary" -xzf "/tmp/ruying-skill-market-server-$sha.tar.gz"
chown -R root:root "$temporary"
find "$temporary" -type d -exec chmod 0755 {} +
find "$temporary" -type f -exec chmod 0644 {} +
cd "$temporary/packages/skill-market-server"
sudo -u ruying-market /usr/local/bin/bun script/deploy-check.ts preflight
mv "$temporary" "$target"
REMOTE
```

Expected: preflight 不出现 `FAIL`，候选 release 原子安装到以提交 SHA 命名的目录。

- [ ] **Step 3: 备份数据库、暂停后台定时任务并切换 API**

```bash
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 "sha='$sha' bash -s" <<'REMOTE'
set -euo pipefail
root=/srv/ruying-skill-market
systemctl start ruying-skill-market-backup.service
systemctl stop ruying-skill-market-worker.timer ruying-skill-market-sync.timer
link="$root/.current-$$.tmp"
ln -s "releases/$sha" "$link"
mv -Tf "$link" "$root/current"
systemctl restart ruying-skill-market
for attempt in 1 2 3 4 5; do
  curl -fsS --max-time 5 http://127.0.0.1:4210/health >/dev/null && break
  if [ "$attempt" = 5 ]; then exit 1; fi
  sleep 1
done
systemctl is-active ruying-skill-market
readlink -f "$root/current"
REMOTE
```

Expected: API 服务 active，健康检查通过，当前软链指向新 SHA；备份成功后才发生切换。

- [ ] **Step 4: 安装、校验并切换 Web release**

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

Expected: manifest 中每个文件的大小和 SHA-256 均匹配，Web 软链指向新 release，Nginx active。

- [ ] **Step 5: 运行线上烟雾检查并恢复定时任务**

```bash
curl -fsS 'http://10.246.13.226:4211/v1/auth/session' | rg '^(null|\{)'
curl -fsS -o /dev/null -w '%{http_code}\n' 'http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/admin'
curl -fsS -o /dev/null -w '%{http_code}\n' 'http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/admin/submissions/sub_abcdefgh'
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 'cd /srv/ruying-skill-market/current/packages/skill-market-server && sudo -u ruying-market /usr/local/bin/bun script/deploy-check.ts smoke && systemctl start ruying-skill-market-worker.timer ruying-skill-market-sync.timer && systemctl is-active ruying-skill-market-worker.timer ruying-skill-market-sync.timer'
```

Expected: 会话接口返回 JSON，两个 SPA 深链接返回 `200`，部署 smoke 通过，worker/sync timer 均 active。不要在生产中创建测试审核决定。

- [ ] **Step 6: 失败时原子回滚**

任一健康、manifest 或 smoke 检查失败时运行：

```bash
previous_api_release=$(basename "$previous_api")
previous_web_release=$(basename "$previous_web")
ssh -p 9922 -o BatchMode=yes root@10.246.13.226 "api='$previous_api_release' web='$previous_web_release' bash -s" <<'REMOTE'
set -euo pipefail
api_link="/srv/ruying-skill-market/.rollback-api-$$"
web_link="/srv/ruying-skill-market/web/.rollback-web-$$"
ln -s "releases/$api" "$api_link"
mv -Tf "$api_link" /srv/ruying-skill-market/current
ln -s "releases/$web" "$web_link"
mv -Tf "$web_link" /srv/ruying-skill-market/web/current
systemctl restart ruying-skill-market
nginx -t
systemctl start ruying-skill-market-worker.timer ruying-skill-market-sync.timer
curl -fsS --max-time 10 http://127.0.0.1:4210/health
REMOTE
```

Expected: API/Web 均恢复到发布前路径，API 健康，后台定时任务恢复；候选不可变 release 保留用于诊断。

---

## Completion Checklist

- [ ] Reviewer 自审仍在服务端返回 `forbidden`，Web 保持禁用提示。
- [ ] Admin 自审在服务端成功并产生审核、发布任务和审计记录。
- [ ] Admin 自有投稿的 Web 审核表单可用。
- [ ] Server/Web 测试、类型检查、生产构建和 desktop-light E2E 全绿。
- [ ] 新 API/Web release 已上线，旧 release 和数据库备份可用于回滚。
- [ ] 线上只执行无副作用 smoke，不创建真实审核决定。
