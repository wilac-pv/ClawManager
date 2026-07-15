# 如影 Code Skill 投稿与审核后台设计

日期：2026-07-15

状态：交互设计已确认，等待书面规格审阅

目标代码线：`ruying-code-oem`

## 1. 目标

在现有如影 Code Skill 市场上增加一套受 GWM SSO 保护的投稿与审核能力：公司用户可以在独立 Web 上传 Skill ZIP、查看自动校验和审核进度、按意见提交修订或新版本；审核员可以在同一站点处理审核、管理角色、下架内容和查看审计记录。只有自动校验通过且人工审核通过的版本才能进入公开目录。

首版继续使用当前单机部署：一个 `skill-market-server` 进程承担公开目录、身份会话、投稿和管理 API；SQLite 保存可变状态，OSS 保存私有隔离文件与公开不可变产物。该设计保留未来将 SQLite 迁移到 PostgreSQL、将管理控制面拆成独立服务的边界。

## 2. 已确认的产品决策

- 投稿用户和审核员都通过 GWM SSO 登录。
- 审核员名单由后台维护；首次超级管理员通过服务器环境变量初始化。
- 用户直接上传 ZIP，不支持 Git 仓库投稿。
- 审核通过的内容使用新的 `community` 来源，在界面显示为“用户投稿”。
- 投稿、审核、角色和审计状态存入服务器本地 SQLite；ZIP、扫描产物和发布快照存入 OSS。
- 审核为单级流程。任一 Reviewer 可以通过、驳回或要求修改，但不能审核自己的投稿。
- 原作者可以提交新版本；每个版本都重新审核，审核期间旧版本继续上架。
- ZIP 可以包含脚本，但服务器绝不执行包内代码，只进行静态扫描和风险标记。
- 独立 Web 提供完整投稿中心；桌面端首版只增加“投稿 Skill”入口并跳转 Web。
- 投稿中心与审核后台共用现有 Skill 市场 Web，路由分别位于 `/submissions` 和 `/admin`。
- 公开目录仍允许匿名只读；所有投稿和管理写接口必须使用同源 SSO 会话、CSRF 防护和角色授权。

## 3. 非目标

- 首版不支持匿名投稿、外部账号、Git 仓库拉取或 SkillHub 账号同步。
- 首版不提供评论、收藏、发布到 SkillHub 或社区社交功能。
- 首版不在服务器沙箱中执行投稿脚本，也不自动运行 Skill 测试。
- 首版不在桌面端实现原生上传表单或审核后台。
- 首版不支持多节点部署；迁移 PostgreSQL 和拆分控制面留作后续演进。
- 首版不允许投稿用户自行授予审核权限、直接上架、直接下架或删除审计记录。

## 4. 总体架构

```text
GWM SSO
   │
   ▼
Skill 市场 Web
  /skills          匿名浏览
  /submissions     登录用户投稿中心
  /admin           Reviewer / Admin 后台
   │
   ▼
skill-market-server
  public catalog   公开只读目录
  auth/session     SSO 与会话
  submissions      上传、校验、状态
  moderation       审核、角色、审计
  publisher        三来源目录重建
   │                        │
   ▼                        ▼
SQLite                    OSS
可变控制状态              私有隔离区 + 公开不可变产物
```

现有公开目录 API 与新增写入控制面必须分开处理安全头：

- `/v1/catalog/*` 保持匿名 `GET/HEAD/OPTIONS` 和 `Access-Control-Allow-Origin: *`。
- `/v1/auth/*`、`/v1/submissions/*`、`/v1/admin/*` 只接受配置的 Web Origin，不允许通配 CORS，不允许跨站凭据。
- 写请求使用 HttpOnly 会话 Cookie，并要求与会话绑定的 `X-CSRF-Token`。

### 4.1 依赖边界

- 公开目录、投稿、审核、角色和审计 DTO 放在 Schema。
- 远程 HTTP 合约放在 Protocol；公开目录组与写入控制面组保持独立。
- SQLite、OSS、SSO 验证、扫描、审核状态机和发布器位于 `skill-market-server`。
- App 与 `skill-market-web` 只依赖 Schema、Protocol 和共享组件，不依赖 Core 或 Server 运行时代码。
- `SkillMarket.Source` 增加 `community`，所有来源分支必须显式处理第三种来源。
- 修改公共 Protocol 或 Server `HttpApi` 后，从 `packages/client` 运行 `bun run generate`，不直接修改生成目录。

## 5. 身份、会话与权限

### 5.1 GWM SSO 登录

Web 登录复用现有 `mode=TOKEN` 流程：

1. `GET /v1/auth/login?returnTo=/submissions` 创建一次性登录尝试，记录随机 attempt ID、到期时间和经过允许列表校验的站内返回路径。
2. 服务端将回调地址 `/v1/auth/callback/:attemptID` 传给 GWM SSO。
3. 回调消费一次性 attempt，拒绝未知、过期或已使用的 attempt。
4. 服务端将 SSO Token 发送给现有开通服务，取得可信 `tokenName` 并按现有规则解析工号和姓名。
5. 市场授权只使用经过验证的员工身份，不保存 SSO Token，也不保存或使用返回的 AI 网关 Key。
6. 服务端生成 256-bit 随机会话值，只在 SQLite 保存哈希，随后设置 HttpOnly、SameSite=Lax Cookie。

内网 IP 测试环境通过显式开关允许非 Secure Cookie。正式域名启用 HTTPS 后，Cookie 改为 `__Host-ruying_market_session`，强制 `Secure`、`Path=/` 且不设置 `Domain`。

会话默认 12 小时绝对过期、2 小时空闲过期。访问受保护接口时更新最后活动时间，但不延长绝对过期时间。退出登录会删除服务端会话并清除 Cookie。

### 5.2 角色

- `submitter`：所有已登录用户的隐式角色，只能管理自己的投稿。
- `reviewer`：查看全部投稿、扫描结果和审核记录；可以通过、驳回或要求修改；不能审核自己的投稿。
- `admin`：包含 Reviewer 权限，并可以管理 Reviewer/Admin 角色、下架或恢复用户投稿、重试发布和查看完整审计日志。

环境变量 `SKILL_MARKET_BOOTSTRAP_ADMIN_EMPLOYEE_IDS` 提供逗号分隔的初始 Admin 工号。仅当数据库中不存在 Admin 时执行引导；一旦完成，后续角色变更全部通过后台并写入审计日志。

禁用用户不能创建会话或提交新修订，已有公开 Skill 不会自动下架。禁用、下架和角色变更是相互独立的审计动作。

## 6. 用户体验

### 6.1 公开市场

- `/skills` 和 `/skills/:source/:id` 保持现有列表与详情体验。
- 来源筛选增加“用户投稿”，详情展示投稿者姓名、版本、审核时间和风险结果。
- 已审核用户投稿使用 `/skills/community/:id` 深链。
- 已登录用户看到“我的投稿”和“投稿 Skill”；未登录用户点击后进入 SSO。
- 桌面端只显示“投稿 Skill”，使用安全外部打开策略跳转 Web 投稿入口。

### 6.2 投稿中心

- `/submissions`：显示当前用户的全部投稿，支持按待审核、要求修改、已上架、驳回和发布失败筛选。
- `/submissions/new`：上传 ZIP，并填写版本、展示名称、简介、分类、标签、许可证、是否需要 API Key 和变更说明。
- `/submissions/:id`：显示自动校验报告、审核意见、状态时间线、修订历史和当前公开版本。
- 要求修改的投稿可上传新修订；历史修订和审核意见只读保留。
- 已上架 Skill 提供“提交新版本”；新版本创建独立投稿，不替换当前公开版本。

根目录 `SKILL.md` 的 `name` 是稳定 Skill ID 的权威来源。表单展示名称可以不同，但不能改变 ID。首次投稿进入待审核时保留该 ID；首次发布后 ID 永久归属该员工，只有原作者能提交后续版本。冲突投稿返回稳定错误，不自动改名；Admin 可以下架或恢复，但不能冒充作者上传版本。

可选图标只接受 PNG、JPEG、WebP 或无脚本 SVG，最大 1 MiB；解码、尺寸和 SVG 允许列表校验通过后才缓存到公开资产目录。未提供或校验失败时使用现有首字母占位。

### 6.3 审核后台

- `/admin`：待审核队列及状态数量，支持按风险、投稿时间、投稿者和状态筛选。
- `/admin/submissions/:id`：显示投稿者身份、元数据、清理后的 README、版本差异、文件清单、静态扫描、风险原因和完整审核记录。
- `/admin/roles`：Admin 管理 Reviewer/Admin；不能删除最后一个 Admin。
- `/admin/audit`：按操作者、动作、对象和时间查询审计事件。
- 审核操作区包含“通过并发布”“要求修改”“驳回”。要求修改和驳回必须填写意见。
- `warning` 或 `danger` 风险的通过操作需要二次确认，并记录 Reviewer 明确接受的风险摘要。

## 7. 投稿状态机

投稿状态使用以下稳定值：

```text
validating
  ├─ validation_failed ──上传新修订──> validating
  └─ pending_review
       ├─ changes_requested ──上传新修订──> validating
       ├─ rejected
       └─ publishing
            ├─ publish_failed ──Admin 重试──> publishing
            └─ published
```

规则：

- `validation_failed`、`changes_requested` 和 `publish_failed` 必须带结构化错误或用户可见说明。
- Reviewer 决定必须携带投稿当前并发版本；版本不匹配返回 `409 submission-conflict`。
- 同一投稿同一时刻最多一个发布任务。
- `published` 投稿保持只读；新版本创建新的投稿记录。
- 驳回关闭当前投稿。用户可以从原内容创建新的投稿，但旧记录不被覆盖。
- 社区 Skill 的公开状态单独记录为 `published` 或 `delisted`；下架不会删除投稿、版本包或审计记录。

## 8. ZIP 校验与风险分析

投稿 ZIP 延续本地安装器的安全限制：

- 压缩包最大 50 MiB。
- 解压后最大 200 MiB。
- 最多 2,000 个文件。
- 最大压缩比 100:1。
- 拒绝绝对路径、路径穿越、空路径、重复路径、符号链接、硬链接和本地文件名与中央目录不一致。
- 根目录必须存在唯一 `SKILL.md`，frontmatter `name` 必须是安全 ID，并与目标社区 Skill ID 一致。
- 版本必须是规范 SemVer，且对同一 Skill 严格高于当前已发布版本。
- 生成压缩包 SHA-256、每个文件的 SHA-256、大小、MIME 和完整清单。

静态风险分析包括：

- 可执行文件、原生二进制、Shell/PowerShell/Python/JavaScript 等脚本类型识别。
- 疑似密钥、Token、私钥和凭据模式检测；命中时不在日志或页面回显完整内容。
- 危险命令、远程下载执行、持久化、权限修改和高风险网络行为模式。
- Markdown/HTML 脚本、事件属性、危险协议和不受信任嵌入。

静态扫描只产生风险等级、原因和证据位置，不执行包内代码。结构不安全或疑似有效凭据直接使校验失败；普通脚本和危险模式可以进入人工审核，但至少标记为 `warning` 或 `danger`。

## 9. SQLite 数据模型

SQLite 使用 `bun:sqlite`、WAL、外键和事务。列名遵循 snake_case。

### 9.1 核心表

- `users`：`employee_id`、`display_name`、`email`、`created_at`、`last_login_at`、`disabled_at`。
- `role_assignments`：`employee_id`、`role`、`created_by`、`created_at`，复合主键为员工与角色。
- `login_attempts`：attempt 哈希、返回路径、创建和过期时间、消费时间。
- `sessions`：会话哈希、员工、CSRF 哈希、创建、活动和过期时间。
- `community_skills`：`skill_id`、所有者工号、当前版本、当前投稿、公开状态和下架原因。
- `submissions`：投稿 ID、Skill ID、所有者、目标版本、状态、当前修订号、并发版本和时间戳。
- `submission_revisions`：投稿、序号、隔离 OSS Key、包哈希、大小、元数据、文件清单、扫描报告和创建时间。
- `reviews`：投稿、修订、Reviewer、决定、意见、风险确认和时间。
- `publish_jobs`：任务类型、投稿、状态、目标目录 revision、租约、尝试次数、错误代码和时间。
- `audit_events`：操作者、动作、对象类型、对象 ID、前后状态摘要、请求关联 ID 和时间。

### 9.2 约束

- `community_skills.skill_id` 唯一。
- 一个 Skill 与版本只能存在一个未终止投稿。
- 修订序号在投稿内唯一且递增。
- 角色值仅允许 `reviewer`、`admin`。
- 审核决定仅允许 `approve`、`request_changes`、`reject`。
- 审计表只追加，没有更新和删除 API。
- 投稿状态变更在事务中同时写入状态、审核记录和审计事件。

数据库文件位于 `/var/lib/ruying-skill-market/market.db`，仅 `ruying-market` 用户可读写。迁移使用有序 SQL 文件和 `PRAGMA user_version`；启动写接口前在独占事务中迁移，失败时不启动服务。

## 10. OSS 布局与权限

投稿隔离区不能位于当前允许匿名读取的 `skill-market-test/*` 下。测试环境使用独立私有前缀：

```text
ai-coding/ruying-code/skill-market-private-test/
  submissions/<employee-hash>/<submission-id>/<revision>/
    package.zip
    manifest.json
    scan.json
  backups/sqlite/<timestamp>.db.zst
```

该前缀不授予匿名读取；Web 永远不会获得 OSS AK/SK。服务账号只获得所需前缀的最小读写权限。

审核通过后的公开内容继续进入现有公开版本区：

```text
ai-coding/ruying-code/skill-market-test/
  packages/community/<skill-id>/<version>/<sha256>.zip
  assets/icons/<sha256>
  indexes/<catalog-revision>/...
  current.json
```

驳回或废弃的私有包保留 30 天后删除；投稿、审核和审计元数据继续保留。公开版本包默认保留，不因下架删除。

## 11. 目录发布与并发

SkillHub 定时同步、企业索引同步和用户投稿发布必须调用同一个目录重建边界：

1. 审核通过在事务中把投稿设为 `publishing` 并插入 `publish_jobs`。
2. 进程内 worker 立即尝试领取任务；现有两分钟 systemd 定时任务同时负责恢复未完成或租约过期的任务。
3. Worker 从 OSS 重新读取并验证隔离包，复制到不可变公开 Key，并用 HEAD 验证大小和哈希元数据。
4. 发布器加载最近成功的 SkillHub、企业索引和全部已发布社区 Skill，生成统一快照。
5. 所有 catalog、facets、details 和引用通过 Schema 验证后，先把目标目录 revision 写入发布任务，再最后更新 `current.json`。
6. 指针更新成功后，在事务中更新 `community_skills` 当前版本和投稿 `published` 状态。

`publish_jobs` 使用 SQLite 租约串行化目录指针更新。进程崩溃或 OSS 失败时，旧指针和旧版本保持有效；任务进入 `publish_failed` 或租约到期后可重试。发布操作必须幂等，相同投稿和哈希的重试复用相同不可变 Key。定时任务先恢复未完成发布，再执行常规来源同步；如果 `current.json` 已指向任务记录的目标 revision，但数据库仍为 `publishing`，恢复逻辑只补写数据库状态和审计事件，避免再次移动指针或让后续同步移除刚发布的版本。

## 12. HTTP API

### 12.1 身份

```text
GET    /v1/auth/login
GET    /v1/auth/callback/:attemptID
GET    /v1/auth/session
DELETE /v1/auth/session
```

### 12.2 投稿用户

```text
GET  /v1/submissions
POST /v1/submissions
GET  /v1/submissions/:submissionID
POST /v1/submissions/:submissionID/revisions
```

`POST` 使用 `multipart/form-data`，包含 ZIP、可选图标和 Schema 校验的 JSON 元数据。服务端流式计算哈希并写入私有 OSS，不把完整 ZIP 保存在内存或本地公开目录。创建成功返回 `202` 和投稿状态；自动校验异步完成。

### 12.3 管理

```text
GET    /v1/admin/submissions
GET    /v1/admin/submissions/:submissionID
POST   /v1/admin/submissions/:submissionID/decision
POST   /v1/admin/submissions/:submissionID/retry-publish
GET    /v1/admin/roles
POST   /v1/admin/roles
DELETE /v1/admin/roles/:employeeID/:role
GET    /v1/admin/audit
POST   /v1/admin/community-skills/:skillID/delist
POST   /v1/admin/community-skills/:skillID/restore
```

所有写请求要求 CSRF Token、会话、角色和期望并发版本。错误返回稳定代码，不暴露异常栈、OSS Key、凭据匹配内容或内部路径。

## 13. 错误处理与滥用保护

- 客户端为创建投稿和上传修订生成幂等键；同一用户、路由和键在 24 小时内返回相同结果。
- 默认每个用户每天最多 20 次上传尝试，最多 5 个非终止投稿；阈值可以通过环境变量降低或提高。
- SSO、OSS 或数据库暂时不可用时不推进状态，返回可重试错误。
- 投稿并发版本不匹配返回 `409 submission-conflict`。
- Skill ID 所有权冲突返回 `409 skill-owned-by-another-user`。
- 发布失败保存稳定错误代码和安全摘要，完整底层错误只进入受限运维日志。
- 日志不记录 SSO Token、会话值、CSRF Token、ZIP 正文、SKILL.md 正文、疑似密钥、用户本地路径或 OSS AK/SK。
- 每个请求带关联 ID，状态变更日志和审计事件使用该 ID 关联。

## 14. 运维与恢复

- 服务继续运行于 `ruying-market` 系统用户，不授予 sudo。
- SQLite 每日执行一致性备份并压缩上传到私有 OSS，保留 30 天。
- 每次数据库迁移前创建本地受限备份；迁移成功后按保留策略清理。
- 每月至少执行一次从 OSS 备份恢复到临时数据库的演练，并运行完整性检查。
- systemd 定时任务每两分钟执行同步和任务恢复；SkillHub 仍按十分钟最小间隔同步。
- 新增指标：投稿创建数、校验耗时与结果、审核等待时间、决定结果、发布任务结果、SSO 登录结果、会话拒绝、角色拒绝、隔离区清理和数据库备份结果。
- 角色变更、审核、发布、重试、下架、恢复和引导 Admin 全部进入审计日志。

IP 测试阶段继续使用现有 4210 API 和 4211 Web。正式域名申请后通过同源 HTTPS 网关暴露 Web 与 `/v1/*`，启用 Secure Cookie，并关闭私有 IP HTTP 开关。

## 15. 测试策略

### 15.1 Schema 与状态机

- 覆盖 `community` 来源、投稿状态、审核决定、角色和错误 DTO。
- 表驱动测试所有合法状态迁移，拒绝越级、重复和终止状态迁移。
- 验证同一事务同时写入状态、审核和审计事件。

### 15.2 SSO 与权限

- 使用真实本地 HTTP 服务测试一次性 attempt、过期、重放、站外 returnTo 和回调失败。
- 测试会话哈希、绝对与空闲过期、退出、CSRF、Origin 和 Cookie 属性。
- 覆盖 Submitter、Reviewer、Admin 权限矩阵、自审禁止、禁用用户和最后一个 Admin 保护。

### 15.3 ZIP 与 OSS

- 使用真实 ZIP 覆盖正常包、路径穿越、绝对路径、重复路径、链接、ZIP bomb、超限、损坏和中央目录不一致。
- 覆盖脚本、原生二进制、疑似密钥、危险 Markdown 和图标校验。
- 验证失败包不进入公开前缀，日志不泄漏命中内容。
- 测试复制、HEAD 验证、不可变 Key、失败重试和指针最后更新。

### 15.4 并发与恢复

- 两名 Reviewer 同时决定时只允许一个成功。
- 重复幂等键、重复 worker、租约过期和进程崩溃恢复不产生重复版本。
- SkillHub 同步与社区发布并发时，统一发布租约保证单一完整指针。
- SQLite 迁移失败、备份、完整性检查和恢复演练使用真实临时数据库。

### 15.5 Web 与桌面

- 浏览器端到端覆盖登录、上传、校验失败、待审核、要求修改、驳回、通过、发布失败重试和新版本。
- 覆盖投稿者看不到他人私有投稿、Reviewer 不能自审、非 Admin 看不到角色管理。
- 覆盖深链刷新、会话过期重登录、键盘操作、焦点、移动端和固定浅色样式。
- 桌面测试验证“投稿 Skill”安全跳转，不在本地读取或上传用户文件。

## 16. 验收标准

- GWM SSO 用户能够上传合法 ZIP，并在投稿中心看到异步校验与审核状态。
- 自动校验失败的包不会进入审核队列或公开 OSS。
- Reviewer 可以要求修改、驳回或通过非本人投稿，所有决定可审计。
- 审核通过且发布成功后，`community` Skill 出现在 Web 和桌面市场，详情与 ZIP 可访问。
- 新版本审核期间旧版本继续可用；发布失败不会移动目录指针。
- 非投稿者无法读取私有投稿，非 Reviewer 无法访问审核数据，非 Admin 无法管理角色和上下架。
- 所有 SSO、CSRF、ZIP 安全、并发审核、OSS 原子发布、数据库恢复和浏览器验收测试通过。
