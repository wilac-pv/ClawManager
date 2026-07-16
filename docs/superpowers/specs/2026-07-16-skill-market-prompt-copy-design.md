# Skill 市场安装 Prompt 复制修复设计

## 问题与根因

Skill 市场当前部署在 `http://10.246.13.226:4211`。浏览器只在安全上下文中开放现代 Clipboard API；私网 IP 的 HTTP 页面不属于安全上下文，因此 `navigator.clipboard` 可能不存在或拒绝写入。当前 Web action 直接调用 `navigator.clipboard.writeText(...)`，详情按钮又用 `void` 丢弃返回的 Promise，导致点击后既没有复制，也没有成功或失败反馈。

现有 E2E 使用 `http://127.0.0.1` 并显式授予剪贴板权限。localhost 属于浏览器的安全上下文例外，所以测试没有覆盖真实私网 IP 部署。

## 目标行为

- 私网 HTTP、localhost 和未来 HTTPS 部署均可复制安装 Prompt。
- 在按钮点击的用户手势内，优先使用隐藏只读文本域和 `document.execCommand("copy")`，以支持私网 HTTP。
- 若兼容复制不可用或返回失败，再调用现代 `navigator.clipboard.writeText(...)`。
- 成功后按钮显示“已复制”，并通过 `role="status"` 告知屏幕阅读器。
- 复制期间按钮禁用并显示“正在复制…”，避免重复请求。
- 两种复制方式均失败时显示明确错误，并展示只读 Prompt 文本域供用户手动复制。
- 下载 ZIP、桌面安装、Prompt 内容和服务端接口保持不变。

## 组件边界

`packages/skill-market-web/src/clipboard.ts` 负责浏览器剪贴板边界。它导出 `copyText(value, adapters?)`，返回 `Promise<boolean>`。默认 adapter 使用 DOM 兼容复制和现代 Clipboard API；测试可注入两个调用函数，不修改浏览器全局对象。

`packages/skill-market-web/src/app.tsx` 使用 `copyText(installPrompt(detail))`。当返回 `false` 时抛出稳定错误，使共享详情组件能够统一处理失败。

`packages/app/src/skill-market/detail.tsx` 只管理交互状态，不感知浏览器 API。它等待 `actions.copyPrompt(detail)`，分别进入 `copying`、`copied` 或 `failed` 状态；失败状态渲染 `installPrompt(detail)` 的只读文本域。

## 错误处理

兼容复制必须同步发生在点击调用链中，以保留浏览器用户手势。隐藏文本域无论成功与否都要从 DOM 移除。现代 Clipboard API 的拒绝转换为 `false`，不得产生未处理 Promise rejection。详情组件捕获 action rejection，并给用户可操作的手动复制退路。

## 测试

1. 剪贴板单元测试覆盖：兼容复制成功时不调用现代 API；兼容复制失败时现代 API 成功；两者均不可用或拒绝时返回 `false`。
2. 详情组件测试覆盖：点击期间禁用；成功显示“已复制”；失败显示 `role="alert"` 和完整只读 Prompt。
3. Web 测试覆盖私网 HTTP 缺少 `navigator.clipboard` 的行为，不再依赖 localhost 的权限例外证明核心复制逻辑。
4. App/Web 全量测试、类型检查、生产构建和 desktop-light E2E 保持通过。

## 发布与回滚

该修复只改变 Web 产物以及 Web 引用的共享 App 组件，不需要发布 API 或迁移数据库。构建内容寻址 Web release，校验 manifest 后原子切换 `/srv/ruying-skill-market/web/current`，保留当前 Web release `88b4fcf6277c7e02` 作为回滚点。线上验证复制成功反馈和实际剪贴板内容；失败时恢复旧 Web 软链。
