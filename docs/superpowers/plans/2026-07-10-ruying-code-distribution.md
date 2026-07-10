# Ruying Code Distribution and Chelper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 CLI 发布为 Nexus npm 包 `@ruying/ruying-code`，让升级与 `chelper` 安装全部使用该渠道。

**Architecture:** 保留现有上游发布脚本，新增如影专用 Nexus 打包入口，只发布 npm 主包和平台可选依赖。Installation 服务在 OEM 构建中只查询该包；`aicoding-helper` 切换工具定义和配置路径。

**Tech Stack:** Bun build, npm pack/publish, Nexus npm registry, Effect HTTP/process, TypeScript

## Global Constraints

- 包名必须为 `@ruying/ruying-code`；安装和版本查询使用 `https://nexus.gwm.cn/repository/npm-group/`，发布使用 hosted 仓库 `https://nexus.gwm.cn/repository/npm-releases/`。
- 自动升级不得访问 OpenCode GitHub、Homebrew、Scoop、Chocolatey 或公网 npm 发布通道。
- npm 主包必须同时安装 `ruying-code` 和 `opencode` 命令。
- 平台包必须作为 optionalDependencies，支持现有 darwin/linux/windows 与 arm64/x64 组合。
- `chelper` 必须安装和探测 `ruying-code`。

---

### Task 1: Build scoped platform packages and the Nexus wrapper

**Files:**
- Create: `packages/opencode/script/publish-ruying.ts`
- Create: `packages/opencode/test/script/publish-ruying.test.ts`
- Modify: `packages/opencode/script/build.ts`
- Modify: `packages/opencode/script/postinstall.mjs`

**Interfaces:**
- Produces: `@ruying/ruying-code-<platform>-<arch>` packages and `@ruying/ruying-code` wrapper.

- [ ] **Step 1: Write manifest-generation tests**

```ts
test("creates a dual-bin scoped wrapper", () => {
  const manifest = wrapperManifest("1.2.3", { "@ruying/ruying-code-darwin-arm64": "1.2.3" })
  expect(manifest.name).toBe("@ruying/ruying-code")
  expect(manifest.bin).toEqual({ "ruying-code": "./bin/ruying-code", opencode: "./bin/ruying-code" })
  expect(manifest.optionalDependencies).toEqual({ "@ruying/ruying-code-darwin-arm64": "1.2.3" })
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/opencode`: `bun test test/script/publish-ruying.test.ts`  
Expected: FAIL because manifest helpers are absent.

- [ ] **Step 3: Implement the scoped manifest helpers**

```ts
export function wrapperManifest(version: string, optionalDependencies: Record<string, string>) {
  return {
    name: "@ruying/ruying-code",
    version,
    bin: { "ruying-code": "./bin/ruying-code", opencode: "./bin/ruying-code" },
    scripts: { postinstall: "node ./postinstall.mjs" },
    optionalDependencies,
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
  }
}
```

Define both registries in the new publisher:

```ts
const INSTALL_REGISTRY = "https://nexus.gwm.cn/repository/npm-group/"
const PUBLISH_REGISTRY = "https://nexus.gwm.cn/repository/npm-releases/"
```

Generate platform package names from `@ruying/ruying-code-${platform}-${arch}` without using the scoped name as a directory path. Update postinstall lookup and error text to those names.

- [ ] **Step 4: Build and test one local target**

Run from `packages/opencode`: `bun run script/build.ts --single --skip-install && bun test test/script/publish-ruying.test.ts`  
Expected: one current-platform binary package plus passing manifest tests.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/script packages/opencode/test/script
git commit -m "feat(opencode): add ruying nexus packages"
```

### Task 2: Restrict update checks to the Nexus package

**Files:**
- Modify: `packages/opencode/src/installation/index.ts`
- Modify: `packages/opencode/test/installation/installation.test.ts`
- Modify: `packages/opencode/src/cli/cmd/upgrade.ts`

**Interfaces:**
- Consumes: `Brand.profile.packageName`.
- Produces: npm/bun/pnpm/yarn upgrade commands for `@ruying/ruying-code`; Nexus latest lookup.

- [ ] **Step 1: Add failing installation tests**

```ts
test("checks the ruying package in the configured nexus registry", async () => {
  const calls: string[] = []
  const layer = testLayer((request) => {
    calls.push(request.url)
    return jsonResponse({ version: "1.2.3" })
  })
  const version = await Effect.runPromise(Installation.use.latest("npm").pipe(Effect.provide(layer)))
  expect(version).toBe("1.2.3")
  expect(calls[0]).toContain("%40ruying%2Fruying-code")
})

test("upgrades the scoped package", async () => {
  const commands: Array<[string, readonly string[]]> = []
  const layer = testLayer(() => jsonResponse({}), (cmd, args) => {
    commands.push([cmd, args])
    return ""
  })
  await Effect.runPromise(Installation.use.upgrade("npm", "1.2.3").pipe(Effect.provide(layer)))
  expect(commands).toContainEqual(["npm", ["install", "-g", "@ruying/ruying-code@1.2.3"]])
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/opencode`: `bun test test/installation/installation.test.ts`  
Expected: FAIL because requests and commands reference `opencode-ai`.

- [ ] **Step 3: Replace external update identities**

```ts
const packageName = Brand.profile.packageName
const encoded = encodeURIComponent(packageName)
const response = yield* httpOk.execute(HttpClientRequest.get(`${registry}/${encoded}/${InstallationChannel}`))
```

For unsupported legacy methods, return `UpgradeFailedError` instructing the user to run the Nexus npm install command; remove OpenCode GitHub/curl/Homebrew/Scoop/Chocolatey network calls from the OEM path.

- [ ] **Step 4: Run tests and typecheck**

Run from `packages/opencode`: `bun test test/installation/installation.test.ts && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/installation/index.ts packages/opencode/test/installation/installation.test.ts packages/opencode/src/cli/cmd/upgrade.ts
git commit -m "feat(opencode): upgrade from ruying nexus package"
```

### Task 3: Add a local package smoke verifier

**Files:**
- Create: `packages/opencode/script/verify-ruying-package.ts`
- Modify: `packages/opencode/package.json`

**Interfaces:**
- Produces: `bun run verify:ruying-package`.

- [ ] **Step 1: Implement an isolated install verifier**

```ts
const root = await fs.mkdtemp(path.join(os.tmpdir(), "ruying-package-"))
await $`npm init -y`.cwd(root)
await $`npm install ${tarball}`.cwd(root)
const primary = await $`${path.join(root, "node_modules/.bin/ruying-code")} --version`.text()
const legacy = await $`${path.join(root, "node_modules/.bin/opencode")} --version`.text()
if (primary.trim() !== legacy.trim()) throw new Error("bin versions differ")
```

- [ ] **Step 2: Add the package script**

```json
{
  "scripts": {
    "verify:ruying-package": "bun run script/verify-ruying-package.ts"
  }
}
```

- [ ] **Step 3: Pack without publishing**

Run from `packages/opencode`: `bun run script/publish-ruying.ts --pack-only`  
Expected: tarballs are created under `dist/` and no registry mutation occurs.

- [ ] **Step 4: Run the smoke verifier**

Run from `packages/opencode`: `bun run verify:ruying-package`  
Expected: both commands print the same version and exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/script/verify-ruying-package.ts packages/opencode/package.json
git commit -m "test(opencode): verify ruying npm package"
```

### Task 4: Switch chelper to 如影 Code

**Files (repository `/Users/gwm/data/github/aicoding-helper`):**
- Modify: `src/core/constants.ts`
- Modify: `src/tools/configurer.ts`
- Modify: `src/ui/wizard.ts`
- Modify: `src/commands/models.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: tool ID `opencode` retained for stored compatibility, command `ruying-code`, npm package `@ruying/ruying-code`, config root `~/.config/ruying-code`.

- [ ] **Step 1: Add a build-time assertion for the tool definition**

Create `src/core/constants.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { SUPPORTED_TOOLS } from "./constants.js"

describe("如影 Code tool", () => {
  it("uses the Nexus OEM package", () => {
    expect(SUPPORTED_TOOLS.find((x) => x.id === "opencode")).toMatchObject({
      name: "如影 Code",
      command: "ruying-code",
      npmPackage: "@ruying/ruying-code",
    })
  })
})
```

Add the test runner explicitly:

```json
{
  "scripts": { "test": "vitest run" },
  "devDependencies": { "vitest": "^3.2.4" }
}
```

- [ ] **Step 2: Verify failure**

Run from `/Users/gwm/data/github/aicoding-helper`: `npm test -- --run`  
Expected: FAIL with the current OpenCode definition.

- [ ] **Step 3: Update installer and configurer constants**

```ts
{
  id: "opencode",
  name: "如影 Code",
  command: "ruying-code",
  installMethod: "npm",
  npmPackage: "@ruying/ruying-code",
  description: "长城汽车企业 AI 编码工具",
}
```

Write gateway config without `apiKey` to `~/.config/ruying-code/ruying-code.json`; retain reading the old OpenCode config only for migration. Write the secret to the platform data directory's `ruying-code/auth.json` as `{ "ruying": { "type": "api", "key": "..." } }`. Do not write `ruyingUser`; the product must still complete SSO once to establish identity. Update user-facing commands to `ruying-code`.

- [ ] **Step 4: Run tests and build**

Run from `/Users/gwm/data/github/aicoding-helper`: `npm test -- --run && npm run build`  
Expected: PASS and `dist/index.js` builds.

- [ ] **Step 5: Commit in the chelper repository**

```bash
git add src README.md package.json package-lock.json
git commit -m "feat(opencode): install ruying code package"
```

### Task 5: Publish rehearsal and acceptance checks

**Files:**
- Modify: `docs/superpowers/specs/2026-07-10-ruying-code-oem-design.md` only if rehearsals reveal a documented contract mismatch.

- [ ] **Step 1: Run package typechecks**

Run: `cd packages/core && bun typecheck`  
Run: `cd packages/opencode && bun typecheck`  
Run: `cd packages/tui && bun typecheck`  
Run: `cd packages/app && bun typecheck`  
Run: `cd packages/desktop && bun typecheck`  
Expected: all exit 0.

- [ ] **Step 2: Run focused package tests**

Run:

```bash
(cd packages/core && bun test test/brand.test.ts test/global.test.ts)
(cd packages/opencode && bun test test/migration/oem.test.ts test/plugin/ruying.test.ts test/server/httpapi-provider.test.ts test/cli/cmd/ruying-auth.test.ts test/auth/ruying-gate.test.ts test/installation/installation.test.ts test/script/publish-ruying.test.ts)
(cd packages/tui && bun test test/component/ruying-login.test.tsx test/app-lifecycle.test.tsx)
(cd packages/app && bun run test:unit -- src/components/ruying-login.test.tsx src/components/ruying-user.test.tsx)
(cd packages/desktop && bun test electron-builder.config.test.ts src/main/migrate.test.ts)
```

Expected: all PASS; no test reaches a production GWM endpoint.

- [ ] **Step 3: Pack and inspect manifests**

Run from `packages/opencode`: `bun run script/publish-ruying.ts --pack-only && bun run verify:ruying-package`  
Expected: wrapper is `@ruying/ruying-code`, platform dependencies are scoped, and both bins work.

- [ ] **Step 4: Rehearse Nexus publish without latest promotion**

Run from `packages/opencode`: `npm publish <wrapper-tarball> --registry=https://nexus.gwm.cn/repository/npm-releases/ --tag beta --dry-run`  
Expected: npm lists only intended files and reports package `@ruying/ruying-code`.

- [ ] **Step 5: Commit any rehearsal fixes**

```bash
git add packages docs
git commit -m "chore(opencode): finalize ruying distribution"
```
