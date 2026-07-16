# Skill 市场私网 HTTP 发布修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让私网 HTTP 部署中的已审核投稿完成发布，同时继续强制包、图标和下载地址使用 HTTPS。

**Architecture:** 共享 Schema 只为市场页面链接增加受限的私网 HTTP 校验，其余远程资源继续使用 `HttpsUrl`。独立 worker 改用包含部署前缀的 `config.webBaseUrl`；API 与 Web 一起发布，现有任务由租约重试机制恢复。

**Tech Stack:** TypeScript、Bun、Effect Schema、SQLite、SolidJS、OSS、systemd、Nginx。

## Global Constraints

- HTTP 只允许市场页面链接使用，且主机必须是 localhost、回环地址或 RFC1918 私网 IPv4。
- URL 不得包含用户名或密码。
- 包、下载、图标、报告和头像 URL 继续强制 HTTPS。
- worker 必须保留 `/ai-coding/ruying-code/skill-market/` 基础路径。
- 不修改数据库、状态机、审核权限或 OSS 对象布局。
- 测试不能从仓库根目录运行；类型检查使用各包的 `bun typecheck`。
- 不直接编辑生成代码。

---

### Task 1: 共享 Schema 的私网页面 URL

**Files:**
- Modify: `packages/schema/test/skill-market.test.ts`
- Modify: `packages/schema/src/skill-market.ts`

**Interfaces:**
- Consumes: `Summary.sourceUrl`、`Detail.publicDetailUrl` 的字符串值。
- Produces: `MarketPageUrl` Schema；HTTPS 总是允许，HTTP 仅允许私网/回环主机，凭据一律拒绝。

- [ ] **Step 1: 写失败测试**

在 `packages/schema/test/skill-market.test.ts` 增加用例，分别解码 `http://10.246.13.226:4211/...` 的 `sourceUrl` 与 `publicDetailUrl`；另断言 `http://example.com/skills/a` 页面链接和 `http://10.0.0.1/a.zip` 包链接解码失败。

- [ ] **Step 2: 运行测试确认 RED**

Run from `packages/schema`:

```bash
bun test test/skill-market.test.ts
```

Expected: 私网 HTTP 页面链接因现有 `^https://` 约束失败。

- [ ] **Step 3: 实现最小 Schema**

在 `packages/schema/src/skill-market.ts` 增加：

```ts
export const MarketPageUrl = Schema.String.check(Schema.makeFilter((value) => {
  const invalid = "market page URL must use HTTPS or private HTTP without credentials"
  if (!URL.canParse(value)) return invalid
  const url = new URL(value)
  if (url.username || url.password) return invalid
  if (url.protocol === "https:") return undefined
  if (url.protocol !== "http:") return invalid
  if (url.hostname === "localhost" || url.hostname === "[::1]") return undefined
  const octets = url.hostname.split(".").map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return invalid
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) ? undefined : invalid
}))
```

仅把 `Summary.sourceUrl` 和 `Detail.publicDetailUrl` 改为 `MarketPageUrl`。

- [ ] **Step 4: 运行测试确认 GREEN**

Run from `packages/schema`:

```bash
bun test test/skill-market.test.ts
bun typecheck
```

Expected: 测试 `0 fail`，类型检查退出 `0`。

- [ ] **Step 5: 提交 Schema 修复**

```bash
git add packages/schema/src/skill-market.ts packages/schema/test/skill-market.test.ts
git commit -m "fix(schema): allow private market page urls"
```

---

### Task 2: 社区目录与独立 worker 基础路径

**Files:**
- Modify: `packages/skill-market-server/test/community.test.ts`
- Modify: `packages/skill-market-server/script/build-release.test.ts`
- Modify: `packages/skill-market-server/src/worker.ts`

**Interfaces:**
- Consumes: `SkillMarketConfig.webBaseUrl`，例如 `http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/`。
- Produces: 具有完整基础路径的社区 `sourceUrl`、`publicDetailUrl`；release worker 将 `config.webBaseUrl` 传给 `createPublisher`。

- [ ] **Step 1: 写失败测试**

在 `community.test.ts` 用私网 HTTP 基础路径生成社区目录并断言详情页 URL 为：

```text
http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/skills/community/community-review
```

在 `build-release.test.ts` 读取构建出的 `src/worker.ts`，断言包含 `webBaseUrl: config.webBaseUrl` 且不包含 `webBaseUrl: config.webOrigin`。

- [ ] **Step 2: 运行测试确认 RED**

Run from `packages/skill-market-server`:

```bash
bun test test/community.test.ts script/build-release.test.ts
```

Expected: 私网 HTTP Schema 和 worker wiring 断言失败。

- [ ] **Step 3: 修复 worker wiring**

把 `packages/skill-market-server/src/worker.ts` 的发布器配置改为：

```ts
webBaseUrl: config.webBaseUrl,
```

- [ ] **Step 4: 运行聚焦验证**

Run from `packages/skill-market-server`:

```bash
bun test test/community.test.ts script/build-release.test.ts
bun typecheck
```

Expected: 两个测试文件 `0 fail`，类型检查退出 `0`。

- [ ] **Step 5: 提交 worker 修复**

```bash
git add packages/skill-market-server/src/worker.ts packages/skill-market-server/test/community.test.ts packages/skill-market-server/script/build-release.test.ts
git commit -m "fix(skill-market): preserve publishing base path"
```

---

### Task 3: 全量验证、不可变发布与任务恢复

**Files:**
- Verify: `packages/skill-market-server/`
- Verify: `packages/skill-market-web/`
- Create generated artifact: `/tmp/ruying-skill-market-server-<git-sha>/`
- Create generated artifact: `/tmp/ruying-skill-market-web-<release>/`

**Interfaces:**
- Consumes: Task 1 与 Task 2 的提交，以及现有发布任务租约。
- Produces: 新 API/Web release；任务状态 `completed`；投稿状态 `published`。

- [ ] **Step 1: 运行全量验证**

Run from `packages/skill-market-server`:

```bash
bun test
bun typecheck
bun run build
```

Run from `packages/skill-market-web`:

```bash
bun test
bun typecheck
bun run build
```

Expected: 所有命令退出 `0`，测试 `0 fail`。

- [ ] **Step 2: 提交文档并合并到 dev**

```bash
git add docs/superpowers/specs/2026-07-16-skill-market-private-http-publishing-design.md docs/superpowers/plans/2026-07-16-skill-market-private-http-publishing.md
git commit -m "docs(skill-market): document publishing recovery"
git -C /Users/gwm/data/gitee/opencode merge --ff-only publishing-link-fix
```

- [ ] **Step 3: 构建并部署不可变 release**

使用仓库现有 Skill 市场 release 脚本构建 API 与 Web 产物，校验 SHA/manifest 后上传至 `10.246.13.226`。安装到新的 release 目录并原子切换 API 与 Web `current` 软链；重启 API，保持旧 release 作为回滚点。

- [ ] **Step 4: 验证线上服务并恢复发布任务**

验证健康检查、Web 深链接与静态资源。租约到期后启动正常 worker 服务，轮询现有任务和投稿，直到任务为 `completed`、投稿为 `published`，并确认公开社区目录包含 `tencent-docs` 及完整私网 HTTP 页面链接。

- [ ] **Step 5: 失败时回滚**

如果线上健康、Web 或发布任务验证失败，将 Web `current` 恢复到 `0e87ad4ba0c44182`，将 API `current` 恢复到 `c2f5de234d35ffc14a0aa22179d6ffd5d436aef1` 并重启 API，然后报告保留的诊断证据。
