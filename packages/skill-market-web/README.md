# Ruying Code Skill Market Web

如影 Code Skill 市场的独立 Web 入口。它与桌面端共享目录、详情和 Markdown 展示组件，提供公开浏览、GWM SSO、用户投稿、Reviewer 审核和 Admin 运营能力。桌面端只安全打开此 Web 投稿页，不在本机处理投稿文件或调用管理接口。

## 本地开发

```bash
VITE_SKILL_MARKET_API_URL=http://127.0.0.1:4200 bun run dev
```

生产构建默认使用页面的 `window.location.origin` 访问同源 `/v1/*`。仅在本地双端口开发或独立 API 部署时设置 `VITE_SKILL_MARKET_API_URL`；私网 HTTP 覆盖仍必须同时设置 `VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP=true`，该开关只放行 RFC 1918 IPv4 地址，不允许公网 HTTP。

```bash
bun test
bun typecheck
bun run build
bun run test:e2e
```

站点的公开基础路径是 `/ai-coding/ruying-code/skill-market/`。公开 Skill 详情路径是 `/skills/:source/:id`；登录后还可访问 `/submissions/*`，Reviewer/Admin 可按角色访问 `/admin/*`。

E2E 使用本地、隔离且无真实员工信息的状态夹具，覆盖 Submitter、Reviewer 和 Admin。每个测试分配独立租户状态，因此可以并发运行而不会互相污染。

## 排版验收

Playwright 固定检查两个视口：桌面 `1440×1000` 与移动端 `390×844`。扫检页面为 `/skills`、`/personal`、`/submissions`、`/groups`、`/favorites`、`/trash` 和 `/admin`；夹具会按页面使用匿名、Submitter、群组负责人或 Admin 身份。

验收命令：

```bash
bun run test:e2e
```

## OSS 发布

发布脚本把每次构建放到内容寻址的不可变版本目录，确认每个对象已经上传且大小正确后，最后更新 `current.json`：

```text
ai-coding/ruying-code/skill-market/web/
├── <release>/
│   ├── index.html
│   ├── assets/...
│   └── manifest.json
└── current.json
```

配置环境变量后发布：

```bash
export SKILL_MARKET_OSS_ENDPOINT=https://oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn
export SKILL_MARKET_OSS_REGION=cn-baoding
export SKILL_MARKET_OSS_BUCKET=app-platform
export SKILL_MARKET_WEB_OSS_PREFIX=ai-coding/ruying-code/skill-market/web
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

bun run build
bun run release
```

静态资源和 `manifest.json` 使用一年不可变缓存；版本内的 `index.html` 与 `current.json` 使用 60 秒缓存。发布凭证只配置在 CI 或发布机上，OSS 对公网仅开放该目录的读取权限，不开放写入和列表权限。

## 网关路由

网关读取 `current.json` 后，应将下列请求映射到当前版本：

- `/ai-coding/ruying-code/skill-market/` → `<release>/index.html`
- `/ai-coding/ruying-code/skill-market/assets/*` → `<release>/assets/*`
- `/ai-coding/ruying-code/skill-market/skills/*` → `<release>/index.html`
- `/ai-coding/ruying-code/skill-market/submissions` → `<release>/index.html`
- `/ai-coding/ruying-code/skill-market/submissions/*` → `<release>/index.html`
- `/ai-coding/ruying-code/skill-market/admin` → `<release>/index.html`
- `/ai-coding/ruying-code/skill-market/admin/*` → `<release>/index.html`

这些单页应用路由回退保证公开详情、投稿详情、审核详情、角色与审计页面直接打开或刷新时不会返回 404。`current.json` 和版本 `manifest.json` 都包含精确的 `fallbacks` 路由映射，网关应使用当前版本的不可变 `index.html` 作为目标。生产默认由网关代理同源 `/v1/*`；独立 API 部署可在构建时通过 `VITE_SKILL_MARKET_API_URL` 覆盖，且必须只允许站点来源并启用凭据，不能用 `Access-Control-Allow-Origin: *`。

## 回滚

使用发布输出的 16 位 `<release>` 切换 `current.json`。脚本会先确认该版本的 `manifest.json` 和 `index.html` 都存在，再更新指针：

```bash
SKILL_MARKET_WEB_ROLLBACK_RELEASE=<release> bun run release
```

回滚不删除任何历史版本。确认新版本稳定后，可以由独立的保留策略清理过期版本；不要在发布或回滚过程中同步删除旧版本。
