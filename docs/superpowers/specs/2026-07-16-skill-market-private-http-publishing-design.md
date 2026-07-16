# Skill 市场私网 HTTP 发布修复设计

## 问题

投稿审核通过后进入 `publishing`，发布 worker 已经把 ZIP 复制到公开 OSS，但在生成社区目录时失败。私网部署用 `http://10.246.13.226:4211/...` 作为市场页面地址，而共享 Schema 把 `sourceUrl` 和 `publicDetailUrl` 与包下载地址一起限制为 HTTPS。定时 worker 还错误地使用 `webOrigin`，丢失 `/ai-coding/ruying-code/skill-market/` 基础路径。

## 设计边界

- `Summary.sourceUrl` 和 `Detail.publicDetailUrl` 使用新的市场页面 URL 校验。
- 市场页面 URL 接受 HTTPS；HTTP 仅接受 `localhost`、回环 IPv4/IPv6 和 RFC1918 私网 IPv4。
- URL 必须是可解析且不含空白的 HTTP(S) 地址，且不得包含用户名或密码。
- `Package.url`、`Download.url`、图标、报告和作者头像继续使用现有 `HttpsUrl`，不放宽 OSS 与下载安全约束。
- 独立 worker 向发布器传入 `config.webBaseUrl`，与 API 内联 worker 和同步任务保持一致，保留完整部署基础路径。
- 不修改投稿状态机、数据库结构、OSS 对象布局或审核权限。

## 发布恢复

API 与 Web 都依赖共享 Schema，因此同时构建和部署不可变 release。现有 `running` 发布任务保留在数据库中，不手工改状态；租约到期后由新 worker 正常重试。成功后任务进入 `completed`，投稿进入 `published`，社区目录包含带完整基础路径的私网 HTTP 页面链接。

## 验证

1. Schema 接受私网 HTTP 页面链接，拒绝公网 HTTP 页面链接，并继续拒绝 HTTP 包链接。
2. 社区目录在私网 HTTP 基础路径下生成正确的 `sourceUrl` 和 `publicDetailUrl`。
3. release 中的独立 worker 使用 `config.webBaseUrl`。
4. Server 与 Web 全量测试、类型检查和生产构建通过。
5. 线上健康检查通过，原发布任务最终为 `completed`，投稿为 `published`，公开目录可读取。

## 回滚

保留当前 API release `c2f5de234d35ffc14a0aa22179d6ffd5d436aef1` 和 Web release `0e87ad4ba0c44182`。若新版本验证失败，先恢复 Web 软链，再恢复 API 软链并重启服务。该变更没有数据库迁移，无需数据回滚。
