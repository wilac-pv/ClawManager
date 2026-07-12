# 如影 Code macOS 打包技能设计

## 目标

创建个人 Codex 技能 `packaging-ruying-code`，以可重复、不可发布的方式从如影 Code OEM 工作树生成本机架构的 macOS 测试产物。首次执行面向当前 `arm64` Mac，输出未使用 Developer ID 签名、未公证的 DMG、ZIP 和解包应用。

## 技能边界

技能安装在 `~/.codex/skills/packaging-ruying-code`，包含：

- `SKILL.md`：触发条件、安全约束、执行顺序和验收标准；
- `agents/openai.yaml`：技能列表元数据；
- `scripts/package-macos.sh`：确定性打包入口。

技能接受以下参数：

- `--repo <path>`：OEM 工作树，默认当前 Git 根目录；
- `--arch arm64|x64|universal`：默认宿主架构，本次为 `arm64`；
- `--channel dev|beta|prod`：默认 `prod`，本次生成产品名“如影 Code”和 Bundle ID `cn.gwm.ruying-code`；
- `--skip-checks`：仅用于已经完成验证的重复打包，默认不启用。

不在主仓增加新的打包脚本，不修改 electron-builder 生产配置。

## 执行流程

脚本先验证工作树、Bun、目标架构和 Desktop package。默认依次执行：

1. 从 `packages/desktop` 运行 `bun typecheck`；
2. 运行 `bun run build`，生成最新 Desktop 与 sidecar 资源；
3. 以 `OPENCODE_CHANNEL=prod`、`CSC_IDENTITY_AUTO_DISCOVERY=false` 调用 electron-builder；
4. 通过 CLI 配置覆盖关闭 `mac.notarize` 和 `dmg.sign`，并强制 `--publish never`；
5. 只生成目标架构的 `dmg` 与 `zip`。

脚本不会读取或使用 Apple ID、公证密码、Developer ID 证书、Nexus 发布凭据，也不会执行 publish、push 或 PR 操作。

## 产物与验证

产物保留在 `packages/desktop/dist/`，预期至少包含：

- `ruying-code-desktop-mac-arm64.dmg`；
- `ruying-code-desktop-mac-arm64.zip`；
- electron-builder 生成的 `如影 Code.app` 目录或等价解包目录。

打包后必须验证：

- DMG 可被 `hdiutil imageinfo` 读取；
- ZIP 通过 `unzip -t`；
- `.app/Contents/Info.plist` 的 `CFBundleDisplayName`/`CFBundleName` 为“如影 Code”，`CFBundleIdentifier` 为 `cn.gwm.ruying-code`；
- `codesign -dv` 不显示 Developer ID 签名；允许 electron-builder/macOS 生成 ad-hoc 签名；
- 两个分发文件非空，并输出绝对路径和 SHA-256。

任何验证失败都使脚本非零退出，且不得把不完整产物报告为成功。

## 技能验证

使用系统 skill-creator 校验器检查 frontmatter、命名与 `agents/openai.yaml`。随后以本次 `arm64/prod` 打包作为真实前向测试，确认技能能从当前 OEM 工作树生成并验证 DMG/ZIP。

受当前团队规则限制，不额外派生子代理做压力测试；真实打包执行和产物验证作为本次技能的端到端验收。
