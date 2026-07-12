# 如影 Code macOS 打包技能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建并安装可复用的 `packaging-ruying-code` 个人技能，然后生成和验证当前 Mac `arm64` 架构的未签名如影 Code DMG/ZIP。

**Architecture:** 个人技能封装仓库现有 Desktop build 与 electron-builder 配置，不修改生产打包配置。低自由度 Shell 脚本强制关闭签名、公证和发布，将产物放入隔离的 `packages/desktop/dist/unsigned-macos-<arch>`，并用 macOS 原生命令验证。

**Tech Stack:** Codex skills, Bash, Bun, electron-builder, hdiutil, unzip, plutil, codesign, shasum

## Global Constraints

- 技能安装到 `~/.codex/skills/packaging-ruying-code`。
- 默认架构为宿主架构；本次必须打包 `arm64`。
- 默认渠道为 `prod`，应用名必须为“如影 Code”，Bundle ID 必须为 `cn.gwm.ruying-code`。
- 禁止 Developer ID 签名、Apple 公证、Nexus/npm 发布、Git push 和 PR。
- 必须生成 DMG、ZIP 和 `.app`，并在报告成功前完成完整性、品牌和 SHA-256 验证。

---

### Task 1: 创建并校验个人打包技能

**Files:**
- Create: `/Users/gwm/.codex/skills/packaging-ruying-code/SKILL.md`
- Create: `/Users/gwm/.codex/skills/packaging-ruying-code/agents/openai.yaml`
- Create: `/Users/gwm/.codex/skills/packaging-ruying-code/scripts/package-macos.sh`

**Interfaces:**
- Produces: `scripts/package-macos.sh [--repo PATH] [--arch arm64|x64|universal] [--channel dev|beta|prod] [--skip-checks]`
- Produces: stdout lines `DMG=...`, `ZIP=...`, `APP=...`, `SHA256 ...` after successful verification.

- [ ] **Step 1: Verify the skill is absent**

Run:

```bash
bash /Users/gwm/.codex/skills/packaging-ruying-code/scripts/package-macos.sh --help
```

Expected: FAIL because the script does not exist.

- [ ] **Step 2: Scaffold the skill**

Run:

```bash
python3 /Users/gwm/.codex/skills/.system/skill-creator/scripts/init_skill.py \
  packaging-ruying-code \
  --path /Users/gwm/.codex/skills \
  --resources scripts \
  --interface display_name="如影 Code 打包" \
  --interface short_description="生成并验证如影 Code 桌面安装包" \
  --interface default_prompt='Use $packaging-ruying-code to build an unsigned macOS test package.'
```

Expected: creates the skill directory, `SKILL.md`, `agents/openai.yaml`, and `scripts/`.

- [ ] **Step 3: Replace `SKILL.md` with the minimal workflow**

```markdown
---
name: packaging-ruying-code
description: Use when building local unsigned macOS DMG/ZIP test artifacts for the Ruying Code Desktop application from an OEM worktree.
---

# Packaging Ruying Code

Run `scripts/package-macos.sh` from this skill. Pass `--repo` when the current directory is not the OEM Git worktree.

The script must remain local-only: never enable signing, notarization, publishing, push, or PR creation. Use `--channel prod` when validating final 如影 Code branding; use `--arch` for the requested Mac architecture.

Do not report success unless the script verifies the DMG, ZIP, app name, Bundle ID, absence of Developer ID signing, and SHA-256 hashes. Return the absolute artifact paths and note that Gatekeeper may require manual approval for unsigned/ad-hoc test builds.
```

- [ ] **Step 4: Implement `scripts/package-macos.sh`**

Use this complete script:

```bash
#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: package-macos.sh [--repo PATH] [--arch arm64|x64|universal] [--channel dev|beta|prod] [--skip-checks]

Builds unsigned, unnotarized local DMG/ZIP artifacts. Never publishes.
USAGE
}

repo=""
arch=""
channel="prod"
skip_checks=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || { echo "missing value for --repo" >&2; exit 2; }
      repo="$2"
      shift 2
      ;;
    --arch)
      [[ $# -ge 2 ]] || { echo "missing value for --arch" >&2; exit 2; }
      arch="$2"
      shift 2
      ;;
    --channel)
      [[ $# -ge 2 ]] || { echo "missing value for --channel" >&2; exit 2; }
      channel="$2"
      shift 2
      ;;
    --skip-checks)
      skip_checks=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS is required" >&2; exit 1; }

if [[ -z "$arch" ]]; then
  case "$(uname -m)" in
    arm64) arch="arm64" ;;
    x86_64) arch="x64" ;;
    *) echo "unsupported host architecture: $(uname -m)" >&2; exit 2 ;;
  esac
fi

case "$arch" in
  arm64|x64|universal) ;;
  *) echo "unsupported architecture: $arch" >&2; exit 2 ;;
esac

case "$channel" in
  dev|beta|prod) ;;
  *) echo "unsupported channel: $channel" >&2; exit 2 ;;
esac

for tool in bun git hdiutil unzip plutil codesign shasum; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

if [[ -z "$repo" ]]; then
  repo="$(git rev-parse --show-toplevel)"
else
  repo="$(cd "$repo" && git rev-parse --show-toplevel)"
fi

desktop="$repo/packages/desktop"
[[ -f "$desktop/package.json" ]] || { echo "desktop package not found: $desktop" >&2; exit 1; }
[[ -f "$desktop/electron-builder.config.ts" ]] || { echo "electron-builder config not found" >&2; exit 1; }

output="$desktop/dist/unsigned-macos-$arch"
rm -rf -- "$output"
mkdir -p "$output"

if [[ "$skip_checks" -eq 0 ]]; then
  (cd "$desktop" && bun typecheck)
  (cd "$desktop" && bun run build)
fi

case "$arch" in
  arm64) arch_flag="--arm64" ;;
  x64) arch_flag="--x64" ;;
  universal) arch_flag="--universal" ;;
esac

(
  cd "$desktop"
  env \
    -u CSC_LINK \
    -u CSC_KEY_PASSWORD \
    -u APPLE_ID \
    -u APPLE_APP_SPECIFIC_PASSWORD \
    -u APPLE_TEAM_ID \
    OPENCODE_CHANNEL="$channel" \
    CSC_IDENTITY_AUTO_DISCOVERY=false \
    bunx electron-builder \
      --mac dmg zip \
      "$arch_flag" \
      --config electron-builder.config.ts \
      --config.directories.output="$output" \
      --config.mac.notarize=false \
      --config.dmg.sign=false \
      --publish never
)

dmg="$output/ruying-code-desktop-mac-$arch.dmg"
zip="$output/ruying-code-desktop-mac-$arch.zip"

case "$channel" in
  prod)
    expected_name="如影 Code"
    expected_id="cn.gwm.ruying-code"
    ;;
  beta)
    expected_name="如影 Code Beta"
    expected_id="cn.gwm.ruying-code.beta"
    ;;
  dev)
    expected_name="如影 Code Dev"
    expected_id="cn.gwm.ruying-code.dev"
    ;;
esac

app="$(find "$output" -type d -name "$expected_name.app" -print -quit)"
[[ -s "$dmg" ]] || { echo "missing or empty DMG: $dmg" >&2; exit 1; }
[[ -s "$zip" ]] || { echo "missing or empty ZIP: $zip" >&2; exit 1; }
[[ -n "$app" ]] || { echo "app bundle not found under $output" >&2; exit 1; }

hdiutil imageinfo "$dmg" >/dev/null
unzip -tq "$zip" >/dev/null

plist="$app/Contents/Info.plist"
bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$plist")"
display_name="$(plutil -extract CFBundleDisplayName raw -o - "$plist" 2>/dev/null || plutil -extract CFBundleName raw -o - "$plist")"
[[ "$bundle_id" == "$expected_id" ]] || { echo "unexpected Bundle ID: $bundle_id" >&2; exit 1; }
[[ "$display_name" == "$expected_name" ]] || { echo "unexpected app name: $display_name" >&2; exit 1; }

codesign_output="$(codesign -dv --verbose=4 "$app" 2>&1 || true)"
if grep -Fq "Developer ID Application" <<<"$codesign_output"; then
  echo "Developer ID signing was unexpectedly enabled" >&2
  exit 1
fi

printf 'DMG=%s\nZIP=%s\nAPP=%s\n' "$dmg" "$zip" "$app"
shasum -a 256 "$dmg" "$zip"
```

Before packaging, remove only the isolated `unsigned-macos-$arch` output directory. Explicitly unset `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for electron-builder.

- [ ] **Step 5: Run static and interface tests**

Run:

```bash
bash -n /Users/gwm/.codex/skills/packaging-ruying-code/scripts/package-macos.sh
bash /Users/gwm/.codex/skills/packaging-ruying-code/scripts/package-macos.sh --help
bash /Users/gwm/.codex/skills/packaging-ruying-code/scripts/package-macos.sh --arch invalid
python3 /Users/gwm/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/gwm/.codex/skills/packaging-ruying-code
```

Expected: syntax/help/skill validation PASS; invalid architecture exits nonzero with a clear error.

### Task 2: 用技能打包并验证 arm64 测试产物

**Files:**
- Produce: `packages/desktop/dist/unsigned-macos-arm64/ruying-code-desktop-mac-arm64.dmg`
- Produce: `packages/desktop/dist/unsigned-macos-arm64/ruying-code-desktop-mac-arm64.zip`
- Produce: `packages/desktop/dist/unsigned-macos-arm64/**/如影 Code.app`

**Interfaces:**
- Consumes: `/Users/gwm/.codex/skills/packaging-ruying-code/scripts/package-macos.sh`
- Produces: verified absolute artifact paths and SHA-256 hashes for user testing.

- [ ] **Step 1: Execute the real package forward test**

Run:

```bash
/Users/gwm/.codex/skills/packaging-ruying-code/scripts/package-macos.sh \
  --repo /Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem \
  --arch arm64 \
  --channel prod
```

Expected: exit 0 with DMG/ZIP/APP paths and SHA-256 output; no publish/sign/notarize action.

- [ ] **Step 2: Independently inspect the artifacts**

Run:

```bash
hdiutil imageinfo packages/desktop/dist/unsigned-macos-arm64/ruying-code-desktop-mac-arm64.dmg
unzip -t packages/desktop/dist/unsigned-macos-arm64/ruying-code-desktop-mac-arm64.zip
find packages/desktop/dist/unsigned-macos-arm64 -name '如影 Code.app' -type d
```

Expected: DMG and ZIP are readable and exactly one app is present.

- [ ] **Step 3: Record verification without committing generated artifacts**

Run `git status --short` from the OEM worktree. Expected: generated `dist` artifacts remain ignored and no tracked source file changes were introduced by packaging.
