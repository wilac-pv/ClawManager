# 如影 Code 完整 OEM 设计

日期：2026-07-10  
状态：已批准

## 背景

当前仓库以 OpenCode 为对外产品身份。本地分支已经包含一版内置如影 SSO Provider 和桌面端登录门禁，但 TUI、CLI、配置目录、环境变量、发布包、升级渠道和桌面安装产物仍然以 OpenCode 为主，现有实现也把登录状态耦合在 Provider 配置中。

本项目将 CLI、TUI、App 和 Desktop 完整 OEM 为“如影 Code”，复用 `/Users/gwm/data/github/aicoding-helper` 中 `chelper login` 的 GWM SSO、个人 Token 开通和网关配置流程。OEM 只改变名称与图标，不重做现有配色、主题、布局或交互。

## 目标

- 对外产品名称统一为“如影 Code”。
- 主命令为 `ruying-code`，兼容命令为 `opencode`。
- npm 包为 Nexus 上的 `@ruying/ruying-code`，由 `chelper` 安装和升级。
- TUI 和桌面端启动时强制完成 GWM SSO 登录。
- 登录后只允许使用如影编码网关，隐藏其他 Provider 与 `/connect`。
- 新安装使用如影命名的配置、数据、缓存、状态和项目目录。
- 自动、幂等、非破坏性地迁移现有 OpenCode 数据。
- 桌面应用名称、Bundle ID、安装器和图标统一为如影 Code。
- 保持内部 `@opencode-ai/*` 包名、协议类型和大部分源码符号，降低后续合并上游的成本。

## 非目标

- 不全仓替换内部 TypeScript 包名或命名空间。
- 不重做 TUI 或桌面端的配色、主题、布局和交互结构。
- 不在本阶段设计正式品牌图标；使用集中管理、可直接替换的占位图标。
- 不允许用户添加第三方 Provider。
- 不删除迁移来源中的 OpenCode 文件。

## 已确认的产品标识

| 项目 | 新值 | 兼容值 |
| --- | --- | --- |
| 展示名称 | 如影 Code | OpenCode 仅用于迁移识别 |
| 主命令 | `ruying-code` | `opencode` |
| npm 包 | `@ruying/ruying-code` | 不再从 `opencode-ai` 升级 |
| 配置标识 | `ruying-code` | `opencode` |
| 环境变量前缀 | `RUYING_CODE_` | `OPENCODE_` |
| 项目配置目录 | `.ruying-code/` | `.opencode/` |
| 桌面 Bundle ID | `cn.gwm.ruying-code` | 无 |
| 唯一 Provider | `ruying` | 其他 Provider 不暴露 |

## 方案选择

采用“集中式 OEM 配置 + 内部兼容层”。对外边界读取统一品牌配置，内部模块继续使用现有 OpenCode 包和类型名称。

未采用以下方案：

- 全仓硬改名：品牌纯度最高，但会产生巨大差异并持续阻碍上游同步。
- 外层包装器：交付更快，但配置路径、错误、协议和桌面产物仍会泄露 OpenCode 品牌。

## 总体架构

### 品牌配置

在 Core 中建立唯一 OEM 品牌配置，至少包含：

- 展示名、英文名、CLI 名称和兼容 CLI 名称
- npm 包名和升级来源
- 配置、数据、缓存、状态和项目目录标识
- 新旧环境变量前缀
- 桌面名称、Bundle ID 和安装器名称
- 占位图标资源入口
- 唯一允许的 Provider ID

TUI、CLI、App、Desktop、Server 和迁移逻辑只能消费该配置，不在各调用点重复硬编码“如影 Code”或 `ruying-code`。

### 各层职责

- Core：品牌配置、平台路径映射和兼容环境变量读取规则。
- Server/Auth：如影 SSO、凭据和公开身份元数据；只启用 `ruying` Provider。
- CLI：`ruying-code` 主入口、`opencode` 兼容入口、登录/退出命令和升级命令。
- TUI：品牌字标、终端标题、强制登录门禁、用户状态和退出入口。
- App：全屏登录门禁、用户状态、退出入口和展示名称。
- Desktop：应用名、Bundle ID、图标、协议、安装器和系统集成名称。
- Migration：旧目录、配置、凭据、会话、插件、技能和环境变量兼容。
- `aicoding-helper`：安装和升级 `@ruying/ruying-code`，不再安装 `opencode-ai`。

## SSO 与登录门禁

### 启动检查

1. 进程启动后先运行一次幂等迁移。
2. Server 检查 `ruying` 凭据和 SSO 身份元数据。
3. 未登录时：
   - TUI 显示专用登录页，阻止进入会话。
   - App/Desktop 显示全屏 SSO 登录页。
   - 非交互命令返回可操作提示，要求执行 `ruying-code login`。
4. 已登录时只加载 `ruying` Provider 和如影网关模型。
5. `/connect`、Provider 列表和第三方 Provider 登录入口不再对用户显示。

### 登录流程

1. `ruying-code login`、TUI 登录入口或桌面登录按钮调用同一个 ProviderAuth 流程。
2. 启动短生命周期本地 HTTP 回调服务，默认端口为 `9527`。
3. 构造 `mode=TOKEN` 的 GWM SSO 地址并自动打开浏览器，同时显示可复制地址。
4. 支持 `RUYING_CODE_CALLBACK_HOST`、回调端口覆盖和 SSH 端口转发提示。
5. 回调收到 SSO access token 后，调用 `aicoding-admin` 的 `/api/provision/token` 换取个人 API Key。
6. 调用 GWM `check_token` 获取工号、姓名和邮箱。
7. 使用 API Key 拉取如影网关模型。
8. API Key 写入凭据存储；公开身份元数据写入可供 TUI 和 App 读取的 Provider 状态。
9. Provider 配置强制为 `enabled_providers: ["ruying"]`，随后重新加载实例和界面状态。

现有本地 `RuyingAuthPlugin` 作为实现起点，但应整合到统一品牌、路径和登录状态模型中，避免 TUI 与 App 分别维护不同的门禁判断。

### 退出登录

`ruying-code logout`、TUI 和 App 的退出入口调用同一逻辑：

- 删除 `ruying` API 凭据。
- 删除 SSO 身份元数据。
- 保留会话、项目配置和非敏感设置。
- 重新加载状态并立即回到登录门禁。

## 路径与数据迁移

### 新路径

- 配置：平台标准配置根目录下的 `ruying-code/`。
- 数据和凭据：平台标准数据根目录下的 `ruying-code/`。
- 缓存和状态：平台标准缓存/状态根目录下的 `ruying-code/`。
- 项目配置：`.ruying-code/`。
- 配置文件优先使用如影命名；旧 `opencode.json`、`opencode.jsonc` 和 `.opencode/` 作为兼容来源。

### 迁移规则

- 只在新状态中不存在完成标记时执行。
- 复制旧配置、会话数据库、凭据、插件、技能和 TUI 设置，不移动或删除来源文件。
- 新旧文件冲突时新目录优先，只补充缺失内容。
- 先写临时文件并原子替换，所有关键步骤成功后才写完成标记。
- 迁移失败不写完成标记，下一次启动可重试。
- 同时读取 `.ruying-code/` 和 `.opencode/`，前者优先。
- 迁移已有如影 API Key，但没有 SSO 身份元数据时仍然要求登录一次。
- 迁移后将 Provider 范围规范化为只允许 `ruying`，不继承第三方 Provider 可见性。
- JSON 和 JSONC 使用现有解析能力更新；无法解析时报告错误并保留原文件。

## 命令和环境变量兼容

- npm 包的 `bin` 同时导出 `ruying-code` 和 `opencode`，两者进入同一实现。
- 通过 `opencode` 启动时显示一次迁移提示，但功能保持可用。
- 新代码优先读取 `RUYING_CODE_*`；未设置时回退到一一对应的 `OPENCODE_*`。
- 不自动修改用户 shell 配置。
- 新文档、帮助、错误和诊断信息只展示 `RUYING_CODE_*` 与 `ruying-code`。
- 内部编译时常量若不属于用户接口，可以继续使用现有 OpenCode 名称。

## TUI 和桌面品牌

仅替换产品名称和图标：

- TUI 字标、终端标题、帮助、状态页、崩溃页和升级提示改为“如影 Code”。
- App/Desktop 窗口标题、菜单、关于页、应用清单、安装器和系统集成名称改为“如影 Code”。
- Desktop Bundle ID 使用 `cn.gwm.ruying-code`。
- 正式图标未提供前使用一个集中管理的占位图标；未来替换资源文件即可，不改业务代码。
- 现有颜色、主题、布局和交互保持不变。

## 发布与升级

- Nexus 发布包为 `@ruying/ruying-code`。
- 自动升级只查询和安装该包，不访问 OpenCode 的发布渠道。
- `chelper` 的 OpenCode 安装定义改为如影 Code，并安装 `@ruying/ruying-code`。
- Desktop 使用如影命名的版本、安装器和更新源；不复用 OpenCode 的生产更新通道。
- 发布验证必须从打包产物安装，不能只验证源码启动。

## 异常处理

- 回调端口被占用：显式端口给出占用信息；默认端口冲突时选择可用端口。
- 浏览器无法自动打开：保留完整、可复制的 SSO URL。
- 登录超过五分钟：关闭回调服务，清理进行中状态并允许重试。
- SSO 无效、请求限流、开通服务不可达和网关不可达显示不同的中文错误。
- Token 待管理员开通：不保存可用登录状态，继续停留在门禁。
- 模型同步失败：保留已经成功获得的凭据，下次启动自动重试。
- 登录请求被新请求替代：前一个请求以可恢复错误结束，不留下监听端口。
- 配置或迁移失败：不覆盖用户文件，不写完成标记。
- 退出登录失败：保留当前登录状态并显示错误，不展示假成功。

## 测试策略

### 单元测试

- 品牌配置及各平台路径映射。
- `ruying-code` / `opencode` 命令别名。
- `RUYING_CODE_*` 优先和 `OPENCODE_*` 回退。
- 迁移幂等性、冲突优先级、失败重试和完成标记。
- SSO URL、回调解析、超时、待开通和用户信息解析。
- Provider 隔离和如影模型注册。

### 集成测试

- 使用本地 HTTP 测试服务覆盖 SSO、Admin 和模型接口，不访问生产环境。
- 覆盖登录成功、Token 待开通、401、429、超时和模型同步失败。
- 覆盖凭据保存、公开身份状态、退出登录和重新进入门禁。
- 如修改公共 Protocol 或 Server HttpApi，按仓库要求在 `packages/client` 运行 `bun run generate`，不手改生成目录。

### 界面与构建测试

- TUI：登录门禁、名称、终端标题、隐藏 `/connect` 和 Provider 隔离。
- App：登录页、用户信息、退出登录和品牌文案。
- Desktop：macOS、Windows、Linux 的应用名、Bundle ID、安装器和占位图标。
- 包发布：`npm pack` 后在临时目录安装，验证 `ruying-code` 与 `opencode` 两个命令。
- 分别在相关包目录执行测试和 `bun typecheck`，不在仓库根目录运行测试。

## 分阶段交付

1. 品牌配置、命令、路径和迁移。
2. SSO 服务、TUI 门禁和 Provider 隔离。
3. App/Desktop 品牌、门禁和安装器。
4. Nexus 包、`chelper` 接入和跨平台验收。

每个阶段都必须保持可测试，并在进入下一阶段前通过其相关包的类型检查和测试。

## 验收标准

- 新用户通过 Nexus 安装 `@ruying/ruying-code` 后可运行 `ruying-code`。
- `opencode` 兼容命令仍可用，并进入同一如影 Code 实现。
- 首次打开 TUI 或桌面端必须完成 GWM SSO，不能绕过门禁进入会话。
- 登录成功后只看到如影网关模型，不出现其他 Provider 或 `/connect`。
- Token 待开通、登录超时和网络失败都有明确、可重试的中文提示。
- 旧 OpenCode 配置和会话可迁移，旧文件保持不变，重复启动不会重复迁移。
- TUI、CLI、App、Desktop、安装器和升级提示统一展示“如影 Code”。
- 产品主题、配色、布局和交互与当前版本一致。
- 替换占位图标资源后，无需修改业务代码即可生成正式品牌产物。
