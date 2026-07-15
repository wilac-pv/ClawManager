# Ruying Code Skill Market Web

如影 Code Skill 市场的独立 Web 入口。它与桌面端共享目录、详情和 Markdown 展示组件，只提供浏览、搜索、筛选、复制安装命令和下载能力；不包含登录、社区发布或直接写入本机 Skill 的能力。

## 本地开发

```bash
VITE_SKILL_MARKET_API_URL=http://127.0.0.1:4200 bun run dev
```

`VITE_SKILL_MARKET_API_URL` 在生产构建中必须是 HTTPS 地址。本地开发允许使用 loopback HTTP。

```bash
bun test
bun typecheck
bun run build
bun run test:e2e
```

站点的公开基础路径是 `/ai-coding/ruying-code/skill-market/`，Skill 详情路径是 `/skills/:owner/:name`。

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
export VITE_SKILL_MARKET_API_URL=https://example.internal/v1/catalog
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

最后一条是单页应用路由回退，保证直接打开或刷新 Skill 详情页时不会返回 404。目录 API 可以由网关代理到同源 `/v1/catalog/*`，也可以在构建时通过 `VITE_SKILL_MARKET_API_URL` 指向独立 HTTPS API。

## 回滚

使用发布输出的 16 位 `<release>` 切换 `current.json`。脚本会先确认该版本的 `manifest.json` 和 `index.html` 都存在，再更新指针：

```bash
SKILL_MARKET_WEB_ROLLBACK_RELEASE=<release> bun run release
```

回滚不删除任何历史版本。确认新版本稳定后，可以由独立的保留策略清理过期版本；不要在发布或回滚过程中同步删除旧版本。
