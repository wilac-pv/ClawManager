# Ruying Code Brand and Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立统一的如影 Code 品牌配置、外部命令与路径，并无损迁移 OpenCode 数据。

**Architecture:** 在 Core 增加只描述外部身份的 `Brand` 模块，现有内部 `@opencode-ai/*` 名称保持不动。CLI 启动时执行幂等迁移，新名称优先、旧名称只作为兼容来源。

**Tech Stack:** TypeScript, Bun, Effect, Node filesystem, yargs, bun:test

## Global Constraints

- 展示名必须为“如影 Code”，主命令必须为 `ruying-code`，兼容命令必须为 `opencode`。
- 新存储标识为 `ruying-code`，旧 `opencode` 文件只读兼容且不得删除。
- `RUYING_CODE_*` 优先于对应的 `OPENCODE_*`。
- 内部 `@opencode-ai/*` 包名和协议类型不得全局重命名。
- 测试和 `bun typecheck` 必须从具体 package 目录运行。

---

### Task 1: Central brand profile

**Files:**
- Create: `packages/core/src/brand/brand.ts`
- Create: `packages/core/test/brand.test.ts`

**Interfaces:**
- Produces: `Brand.Profile`, `Brand.profile`, `Brand.env(suffix)`, `Brand.truthy(suffix)`.

- [ ] **Step 1: Write the failing brand test**

```ts
import { expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand/brand"

test("defines the public ruying identity", () => {
  expect(Brand.profile).toEqual({
    displayName: "如影 Code",
    englishName: "Ruying Code",
    cliName: "ruying-code",
    legacyCliName: "opencode",
    packageName: "@ruying/ruying-code",
    storageName: "ruying-code",
    legacyStorageName: "opencode",
    projectDirectory: ".ruying-code",
    legacyProjectDirectory: ".opencode",
    providerID: "ruying",
  })
})

test("prefers RUYING_CODE variables over OPENCODE variables", () => {
  process.env.RUYING_CODE_CONFIG = "new.json"
  process.env.OPENCODE_CONFIG = "old.json"
  expect(Brand.env("CONFIG")).toBe("new.json")
  delete process.env.RUYING_CODE_CONFIG
  expect(Brand.env("CONFIG")).toBe("old.json")
  delete process.env.OPENCODE_CONFIG
})
```

- [ ] **Step 2: Verify the test fails**

Run from `packages/core`: `bun test test/brand.test.ts`  
Expected: FAIL because `@opencode-ai/core/brand/brand` does not exist.

- [ ] **Step 3: Implement the profile and environment bridge**

```ts
export interface Profile {
  displayName: string
  englishName: string
  cliName: string
  legacyCliName: string
  packageName: string
  storageName: string
  legacyStorageName: string
  projectDirectory: string
  legacyProjectDirectory: string
  providerID: string
}

export const profile = {
  displayName: "如影 Code",
  englishName: "Ruying Code",
  cliName: "ruying-code",
  legacyCliName: "opencode",
  packageName: "@ruying/ruying-code",
  storageName: "ruying-code",
  legacyStorageName: "opencode",
  projectDirectory: ".ruying-code",
  legacyProjectDirectory: ".opencode",
  providerID: "ruying",
} satisfies Profile

export function env(suffix: string) {
  return process.env[`RUYING_CODE_${suffix}`] ?? process.env[`OPENCODE_${suffix}`]
}

export function truthy(suffix: string) {
  const value = env(suffix)?.toLowerCase()
  return value === "true" || value === "1"
}

export * as Brand from "./brand"
```

- [ ] **Step 4: Run test and typecheck**

Run from `packages/core`: `bun test test/brand.test.ts && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/brand/brand.ts packages/core/test/brand.test.ts
git commit -m "feat(core): add ruying brand profile"
```

### Task 2: Branded global paths and environment aliases

**Files:**
- Modify: `packages/core/src/global.ts`
- Modify: `packages/core/src/flag/flag.ts`
- Modify: `packages/core/test/global.test.ts`
- Modify: `packages/core/test/brand.test.ts`

**Interfaces:**
- Consumes: `Brand.profile`, `Brand.env`, `Brand.truthy`.
- Produces: canonical `Global.Path.*` under `ruying-code`; existing `Flag.OPENCODE_*` properties remain source-compatible.

- [ ] **Step 1: Update failing path and flag tests**

```ts
test("uses the ruying storage name", () => {
  expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "ruying-code"))
  expect(Global.Path.config.endsWith("ruying-code")).toBe(true)
})

test("legacy flag properties prefer branded variables", async () => {
  process.env.RUYING_CODE_SERVER_USERNAME = "ruying"
  process.env.OPENCODE_SERVER_USERNAME = "legacy"
  const { Flag } = await import(`../src/flag/flag.ts?brand=${Date.now()}`)
  expect(Flag.OPENCODE_SERVER_USERNAME).toBe("ruying")
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/core`: `bun test test/global.test.ts test/brand.test.ts`  
Expected: FAIL with paths still ending in `opencode`.

- [ ] **Step 3: Switch external paths and flag reads**

In `global.ts`, replace the hard-coded app constant:

```ts
import { Brand } from "./brand/brand"

const app = Brand.profile.storageName
```

In `flag.ts`, keep public property names but route every `OPENCODE_` lookup through two compatibility helpers:

```ts
import { Brand } from "../brand/brand"

function value(key: string) {
  return Brand.env(key.replace(/^OPENCODE_/, ""))
}

export function truthy(key: string) {
  const current = value(key)?.toLowerCase()
  return current === "true" || current === "1"
}

export const Flag = {
  OPENCODE_CONFIG: value("OPENCODE_CONFIG"),
  OPENCODE_SERVER_USERNAME: value("OPENCODE_SERVER_USERNAME"),
  OPENCODE_DISABLE_AUTOUPDATE: truthy("OPENCODE_DISABLE_AUTOUPDATE"),
  get OPENCODE_CONFIG_DIR() {
    return value("OPENCODE_CONFIG_DIR")
  },
}
```

Replace the remaining direct `process.env["OPENCODE_..."]` reads in this file with `value("OPENCODE_...")`; `OTEL_*` reads stay unchanged because they are not product-prefixed.

- [ ] **Step 4: Run tests and typecheck**

Run from `packages/core`: `bun test test/global.test.ts test/brand.test.ts && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/global.ts packages/core/src/flag/flag.ts packages/core/test/global.test.ts packages/core/test/brand.test.ts
git commit -m "feat(core): use ruying paths and env aliases"
```

### Task 3: Idempotent legacy data migration

**Files:**
- Create: `packages/opencode/src/migration/oem.ts`
- Create: `packages/opencode/test/migration/oem.test.ts`
- Modify: `packages/opencode/src/index.ts`

**Interfaces:**
- Produces: `OemMigration.run({ pairs, marker }): Promise<{ copied: string[]; skipped: string[] }>`; one marker is written only after all config/data/cache/state pairs succeed.

- [ ] **Step 1: Write migration tests**

```ts
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { OemMigration } from "../../src/migration/oem"

test("copies missing files and never overwrites the new tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-"))
  const legacy = join(root, "opencode")
  const current = join(root, "ruying-code")
  await mkdir(legacy, { recursive: true })
  await mkdir(current, { recursive: true })
  await writeFile(join(legacy, "auth.json"), "legacy")
  await writeFile(join(current, "auth.json"), "current")
  await writeFile(join(legacy, "opencode.db"), "session")

  const marker = join(root, "ruying-code-state", ".oem-migration-v1.json")
  await OemMigration.run({ pairs: [{ legacy, current }], marker })
  await OemMigration.run({ pairs: [{ legacy, current }], marker })

  expect(await readFile(join(current, "auth.json"), "utf8")).toBe("current")
  expect(await readFile(join(current, "opencode.db"), "utf8")).toBe("session")
  expect(await Bun.file(marker).exists()).toBe(true)
})
```

- [ ] **Step 2: Verify failure**

Run from `packages/opencode`: `bun test test/migration/oem.test.ts`  
Expected: FAIL because `OemMigration` is missing.

- [ ] **Step 3: Implement copy-if-missing and marker semantics**

```ts
import { cp, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

export async function run(input: { pairs: Array<{ legacy: string; current: string }>; marker: string }) {
  if (await Bun.file(input.marker).exists()) return { copied: [], skipped: [] }
  const copied: string[] = []
  const skipped: string[] = []
  for (const pair of input.pairs) {
    await mkdir(pair.current, { recursive: true })
    const entries = await readdir(pair.legacy, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const target = path.join(pair.current, entry.name)
      if (await Bun.file(target).exists()) {
        skipped.push(`${pair.legacy}/${entry.name}`)
        continue
      }
      await cp(path.join(pair.legacy, entry.name), target, { recursive: entry.isDirectory(), errorOnExist: true })
      copied.push(`${pair.legacy}/${entry.name}`)
    }
  }
  await mkdir(path.dirname(input.marker), { recursive: true })
  await writeFile(input.marker, JSON.stringify({ version: 1, copied, skipped }, null, 2))
  return { copied, skipped }
}

export * as OemMigration from "./oem"
```

Call `OemMigration.run` from CLI middleware before command execution with four pairs for config, data, cache, and state, deriving legacy roots from the same XDG bases as `Global.Path`.

- [ ] **Step 4: Run tests and typecheck**

Run from `packages/opencode`: `bun test test/migration/oem.test.ts && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/migration/oem.ts packages/opencode/test/migration/oem.test.ts packages/opencode/src/index.ts
git commit -m "feat(opencode): migrate legacy opencode data"
```

### Task 4: Config discovery and CLI identity

**Files:**
- Modify: `packages/opencode/src/config/paths.ts`
- Modify: `packages/opencode/src/config/config.ts`
- Modify: `packages/opencode/src/config/tui-migrate.ts`
- Modify: `packages/opencode/test/config/config.test.ts`
- Modify: `packages/opencode/src/index.ts`
- Modify: `packages/opencode/package.json`
- Create: `packages/opencode/test/cli/brand.test.ts`

**Interfaces:**
- Consumes: `Brand.profile`.
- Produces: `.ruying-code` and `ruying-code.json[c]` precedence; two npm bin names.

- [ ] **Step 1: Add failing config precedence and package manifest tests**

```ts
import { expect, test } from "bun:test"
import { ConfigPaths } from "../../src/config/paths"

test("publishes both command names", async () => {
  const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
  expect(pkg.bin).toEqual({ "ruying-code": "./bin/opencode", opencode: "./bin/opencode" })
})

test("orders legacy config before ruying config so ruying wins merge precedence", () => {
  expect(ConfigPaths.projectDirectoryNames).toEqual([".opencode", ".ruying-code"])
  expect(ConfigPaths.globalConfigNames).toEqual(["opencode", "ruying-code"])
})
```

- [ ] **Step 2: Verify tests fail**

Run from `packages/opencode`: `bun test test/config/config.test.ts test/cli`  
Expected: FAIL because only OpenCode paths and bin exist.

- [ ] **Step 3: Implement branded discovery and display**

Use both project directory targets with new first in output precedence:

```ts
export const projectDirectoryNames = [Brand.profile.legacyProjectDirectory, Brand.profile.projectDirectory]
export const globalConfigNames = [Brand.profile.legacyStorageName, Brand.profile.storageName]
```

Load global `opencode.json[c]` first and `ruying-code.json[c]` second. Change yargs and help display:

```ts
const cli = yargs(args).scriptName(Brand.profile.cliName)
```

Set package bins:

```json
{
  "bin": {
    "ruying-code": "./bin/opencode",
    "opencode": "./bin/opencode"
  }
}
```

- [ ] **Step 4: Run package verification**

Run from `packages/opencode`: `bun test test/config/config.test.ts test/cli && bun typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/config packages/opencode/test/config packages/opencode/src/index.ts packages/opencode/package.json packages/opencode/test/cli/brand.test.ts
git commit -m "feat(opencode): expose ruying cli and config identity"
```
