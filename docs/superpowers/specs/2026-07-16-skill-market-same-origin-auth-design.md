# Skill 市场同源认证修复设计

## 背景

Skill 市场 Web 当前由 `http://10.246.13.226:4211` 提供，浏览器直接访问
`http://10.246.13.226:4210` 上的 API，SSO 回调也终止在 `4210`。服务端能够完成 SSO、创建用户会话并回跳到投稿页面，但浏览器仍可能以匿名状态访问受保护页面。

线上取证已确认：

- 投稿页面与静态资源返回 `200`，子路径路由已经正常。
- SSO 回调成功，并为 `GW00378008` 创建了未过期的管理员会话。
- 后续取证未观察到该会话的活动时间刷新，说明有效会话 Cookie 没有稳定地到达 API。
- 认证 Cookie 当前没有 `Max-Age` 或 `Expires`，关闭浏览器或切换浏览器上下文后会丢失。

## 目标

1. Web、浏览器 API 请求和 SSO 回调统一使用 `4211` 同源入口。
2. 登录成功后，投稿页能够读取当前会话并显示投稿表单。
3. 登录 Cookie 在浏览器重启后继续有效，最长与服务端 12 小时绝对会话期限一致。
4. 保留 `4210` API 直连，避免破坏现有桌面客户端和运维探针。
5. 保留未来域名和 HTTPS 部署能力，不把 IP 写入前端运行逻辑。

## 非目标

- 不改变 SSO 身份供应商、TOKEN 模式或企业账号开通逻辑。
- 不改变用户、角色、投稿和审核数据模型。
- 不关闭 `4210` 监听端口，也不在本次修改中调整主机防火墙。
- 不改变桌面客户端当前使用的 Skill 市场 API 配置。

## 方案比较

### A. Nginx 同源代理与持久 Cookie（采用）

在 `4211` 增加 `/v1/` 反向代理，Web 在运行时使用 `window.location.origin` 作为控制面 API 基址，SSO 公共回调地址也改为 `4211`。会话与 CSRF Cookie 增加 12 小时 `Max-Age`。

该方案同时消除浏览器跨端口认证依赖和浏览器重启后的 Cookie 丢失，且保留 `4210` 兼容入口。

### B. 仅增加 Cookie 有效期

改动最小，但 Web 仍跨端口访问 API，无法消除浏览器策略、上下文隔离和未来域名迁移带来的差异。

### C. 仅增加 Nginx 同源代理

能够消除跨端口认证链路，但 Cookie 仍是浏览器会话 Cookie，关闭浏览器后仍会重新登录。

## 架构

### 浏览器请求

生产 Web 不再要求构建时注入固定的 API 主机。未提供显式开发覆盖值时，控制面数据源使用 `window.location.origin`，请求以下同源地址：

- `GET /v1/auth/session`
- `GET /v1/auth/login`
- `POST /v1/submissions`
- 其他现有 `/v1` 控制面接口

开发和测试仍可通过 `VITE_SKILL_MARKET_API_URL` 指向独立 API，以保留本地双端口开发能力。显式 HTTP 私网覆盖仍受现有 `VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP` 检查保护。

### Nginx 网关

IP 测试配置在静态资源 location 之前增加精确的 `/v1/` 前缀代理：

- 上游为 `http://127.0.0.1:4210`。
- 保留原始 URI，因此 `/v1/auth/session` 仍由服务端同名路由处理。
- 转发 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。
- 允许最大 55 MiB 请求体，覆盖 50 MiB ZIP、1 MiB 图标和 multipart 开销。
- 关闭请求缓冲，保持现有流式上传边界。

现有 SPA、不可变资源和 OSS 公共对象 location 保持不变。CSP 的 `connect-src` 收敛为 `'self' https:`，不再允许浏览器直接连接 `4210`。

### SSO 回调

线上 `SKILL_MARKET_API_PUBLIC_URL` 改为 `http://10.246.13.226:4211`。服务端生成的 SSO `redirect_url` 因此为：

`http://10.246.13.226:4211/v1/auth/callback/<attempt>`

Nginx 将回调代理到 `4210`。服务端完成认证、设置 Cookie，并继续按照 `SKILL_MARKET_WEB_BASE_PATH` 回跳：

`http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/submissions/new`

### Cookie 生命周期

服务端从 `SKILL_MARKET_SESSION_ABSOLUTE_MINUTES` 计算整数秒 `Max-Age`，并同时应用于：

- HttpOnly 会话 Cookie。
- 与会话同步持久化的非 HttpOnly CSRF Cookie；Web 仍从会话响应取得请求头所需的 CSRF token。

IP 测试环境继续使用非 `Secure` Cookie；未来 HTTPS 环境继续使用 `__Host-` 名称和 `Secure`。登出仍使用 `Max-Age=0` 立即清除两个 Cookie。服务端空闲超时仍具有最终裁决权，因此持久 Cookie 不会延长服务端会话。

## 错误处理与兼容性

- `/v1` 上游不可用时由 Nginx 返回网关错误，不回退到 SPA HTML，避免 JSON 解码得到误导性错误。
- 跨源开发模式保留现有 CORS 行为；生产同源模式不依赖 CORS 才能完成认证。
- `4210` 服务继续监听并接受桌面客户端和运维探针请求。
- 旧的未过期 Cookie 仍可被服务端读取；用户下一次成功登录后获得持久 Cookie。
- 部署先安装并验证 Nginx 代理，再切换 Web 和 SSO 公共回调地址，避免中间状态产生不可达回调。

## 测试策略

### 自动化测试

1. Nginx 配置测试断言 IP 配置存在 `/v1/` 代理、55 MiB 限制、流式上传设置以及同源 CSP。
2. Web 构建配置测试断言生产构建在未注入固定 API URL 时成功，并保留显式开发覆盖能力。
3. Web 数据源或应用装配测试断言默认 API 基址来自运行时页面 origin。
4. 服务端配置测试断言 Cookie `Max-Age` 从绝对会话期限计算。
5. HTTP 登录测试断言 SSO 回调 URL 使用公共同源入口、两个登录 Cookie 都包含预期 `Max-Age`，并能用返回 Cookie 读取会话。
6. 运行 Skill 市场 Web 与服务端完整测试及类型检查。

### 线上验证

1. `nginx -t` 通过后重载 Nginx。
2. `GET http://10.246.13.226:4211/v1/auth/session` 返回 JSON，而不是 SPA HTML。
3. `/v1/auth/login` 生成的 SSO `redirect_url` 使用 `4211`。
4. 使用真实 GWM SSO 登录后，回跳地址保留 Skill 市场基础路径。
5. 投稿页面显示表单；刷新页面后仍登录。
6. 关闭并重新打开浏览器后，在服务端会话未过期的前提下仍保持登录。

## 部署与回滚

1. 备份当前 Nginx 配置和 `/etc/ruying-skill-market/market.env`。
2. 安装候选 Nginx 配置并运行 `nginx -t`。
3. 重载 Nginx，验证 `4211/v1` 可达。
4. 发布不可变 Web 与 API release。
5. 将 `SKILL_MARKET_API_PUBLIC_URL` 切换为 `http://10.246.13.226:4211`，重启 API。
6. 执行健康检查、认证冒烟和真实浏览器回归。

若验证失败，恢复环境文件和 Nginx 备份，将 Web/API symlink 切回上一不可变 release，并重启或重载对应服务。
