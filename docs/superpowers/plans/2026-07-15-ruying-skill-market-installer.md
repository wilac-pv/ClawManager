# Ruying Skill Market Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为桌面端提供安全的用户全局 Skill 安装、更新、卸载、离线状态读取和无需重启的 Skill 服务刷新能力。

**Architecture:** Core 新增只负责文件事务和安装清单的 `SkillMarketInstaller` Location 服务；Server 新增远程目录代理/可信详情解析，并通过现有 `SkillGroup` 暴露本地 API。安装器使用 ZIP 中央目录预检、同文件系统 staging、SHA-256 校验和原子替换；成功写盘后调用现有 Skill 服务的显式 reload，失败时保留旧版本。

**Tech Stack:** Bun、Effect、Effect HttpApi、`yauzl` 2.10.0、Web Crypto SHA-256、真实临时目录/真实 ZIP、Bun test。

## Global Constraints

- 安装根目录固定为 `path.join(Global.Service.config, "skills")`，属于当前用户且所有项目可见。
- 默认限制：ZIP 50 MiB、解压 200 MiB、2,000 个文件、最大压缩比 100:1。
- 永久拒绝绝对路径、路径穿越、空路径、反斜线逃逸、符号链接和硬链接；OEM 配置不能关闭这些检查。
- 安装只接受 HTTPS、允许域名内、远端目录重新解析后的包；不信任前端传入的风险和下载 URL。
- 风险为 `warning` 或 `danger` 时必须有 `riskConfirmed: true`；`unknown` 也显示风险但首版按 warning 处理。
- 安装期间不执行包内脚本。
- 同一 Skill ID 串行；不同 Skill 最多 4 个并发操作。
- 更新失败必须恢复旧目录；卸载只删除带有效 `.ruying-market.json` 的市场安装，不删除手工 Skill。
- 网络不可用时 installed/uninstall/refresh 仍可工作；list/detail/update-check 可返回稳定网络错误。
- 修改 Protocol/Server `HttpApi` 后必须从 `packages/client` 运行 `bun run generate`，不可直接编辑生成目录。
- 测试和 typecheck 从 package 目录运行，不能从仓库根目录运行测试。

---

## File Structure

- `packages/core/src/skill/market-installer.ts`：锁、下载、校验、解压、原子替换、清单、卸载和刷新。
- `packages/core/src/skill/generation.ts`：跨 Location Skill 缓存失效代数。
- `packages/core/src/skill/zip.ts`：ZIP 中央目录安全预检和受限解压。
- `packages/core/src/skill.ts`：让 `reload()` 同时清空已加载 Skill 缓存。
- `packages/core/test/skill/market-installer.test.ts`：真实文件事务测试。
- `packages/core/test/skill/zip.test.ts`、`fixtures/skill-market/*.zip`：攻击包和限制测试。
- `packages/protocol/src/groups/skill-market-local.ts`：Desktop 本地 API 合约和稳定错误码。
- `packages/server/src/skill-market/catalog.ts`：远程市场代理、缓存和允许域名检查。
- `packages/server/src/handlers/skill-market.ts`：本地 API 到目录代理/安装器的映射。
- `packages/client/src/generated*`：只通过生成命令更新。

### Task 1: Make Skill reload invalidate its content cache

**Files:**
- Create: `packages/core/src/skill/generation.ts`
- Modify: `packages/core/src/skill.ts`
- Create: `packages/core/test/skill/reload.test.ts`

**Interfaces:**
- Consumes: existing `SkillV2.Interface.reload(): Effect.Effect<void>` and directory sources.
- Produces: `SkillGeneration.Service` plus the same reload signature with a stronger guarantee: every active Location sharing the global generation rereads sources on its next `list()`.

- [ ] **Step 1: Write a failing real-filesystem reload test**

```ts
test("reload in one Location invalidates Skill caches in every active Location", async () => {
  await using tmp = await tempDirectory()
  await Bun.write(`${tmp.path}/review/SKILL.md`, "---\nname: review\ndescription: old\n---\nold")
  const services = await makeTwoSkillServicesSharingGeneration(tmp.path)
  expect((await Effect.runPromise(services.first.list()))[0]?.content).toBe("old")
  expect((await Effect.runPromise(services.second.list()))[0]?.content).toBe("old")
  await Bun.write(`${tmp.path}/review/SKILL.md`, "---\nname: review\ndescription: new\n---\nnew")
  await Effect.runPromise(services.first.reload())
  expect((await Effect.runPromise(services.first.list()))[0]?.content).toBe("new")
  expect((await Effect.runPromise(services.second.list()))[0]?.content).toBe("new")
})
```

Use the real `SkillV2.node`, `FSUtil.node`, and a directory source transform; do not replace `list()` with a mock.

- [ ] **Step 2: Verify the test exposes the stale cache**

Run: `cd packages/core && bun test test/skill/reload.test.ts`

Expected: FAIL because the second content remains `old`.

- [ ] **Step 3: Add a global generation service and observe it in every Skill service**

Create a global node with this interface:

```ts
export interface Interface {
  readonly current: () => number
  readonly bump: () => Effect.Effect<number>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SkillGeneration") {}

const layer = Layer.effect(Service, Effect.sync(() => {
  let value = 0
  return Service.of({
    current: () => value,
    bump: Effect.fn("SkillGeneration.bump")(function* () {
      value += 1
      return value
    }),
  })
}))
export const node = makeGlobalNode({ service: Service, layer, deps: [] })
```

Add `SkillGeneration.node` to `SkillV2.node` dependencies. Each Skill service stores `let seenGeneration = generation.current()`. At the start of `list()`, compare `generation.current()`; when different, clear its local cache and update the seen value. Replace the returned `reload: state.reload` binding with:

```ts
reload: Effect.fn("SkillV2.reload")(function* () {
  cache.clear()
  seenGeneration = yield* generation.bump()
  yield* state.reload()
}),
```

Do not add a second public refresh method; existing plugin callers already use `reload()`. The generation service is internal Core coordination, not an HTTP or App API.

- [ ] **Step 4: Run Skill/Core verification**

Run: `cd packages/core && bun test test/skill/reload.test.ts && bun typecheck`

Expected: the reload test passes and Core typechecks.

- [ ] **Step 5: Commit cache invalidation**

```bash
git add packages/core/src/skill/generation.ts packages/core/src/skill.ts packages/core/test/skill/reload.test.ts
git commit -m "fix(core): refresh skill content on reload"
```

### Task 2: Validate and extract ZIP archives safely

**Files:**
- Create: `packages/core/src/skill/zip.ts`
- Create: `packages/core/test/skill/zip.test.ts`
- Create: `packages/core/test/fixtures/skill-market/valid.zip`
- Create: `packages/core/test/fixtures/skill-market/traversal.zip`
- Create: `packages/core/test/fixtures/skill-market/absolute.zip`
- Create: `packages/core/test/fixtures/skill-market/symlink.zip`
- Create: `packages/core/test/fixtures/skill-market/hardlink.zip`
- Create: `packages/core/test/fixtures/skill-market/bomb.zip`
- Modify: `packages/core/package.json`

**Interfaces:**
- Consumes: a ZIP file path, staging directory and `ZipLimits`.
- Produces: `inspectZip(input): Promise<ZipManifest>` and `extractZip(input): Promise<ZipManifest>`; throws tagged `UnsafeArchiveError` or `ArchiveLimitError`.

- [ ] **Step 1: Add real archive attack tests**

```ts
const limits = { archiveBytes: 50 * 1024 * 1024, extractedBytes: 200 * 1024 * 1024, files: 2_000, ratio: 100 }

test("extracts a valid skill and rejects unsafe archive entries", async () => {
  await using tmp = await tempDirectory()
  const manifest = await extractZip({ archive: fixture("valid.zip"), destination: tmp.path, limits })
  expect(manifest.files.map((file) => file.path)).toContain("SKILL.md")
  for (const name of ["traversal.zip", "absolute.zip", "symlink.zip", "hardlink.zip"]) {
    await expect(extractZip({ archive: fixture(name), destination: `${tmp.path}/${name}`, limits })).rejects.toBeInstanceOf(UnsafeArchiveError)
  }
})

test("rejects archive, expanded-size, count and ratio limits before commit", async () => {
  await expect(inspectZip({ archive: fixture("bomb.zip"), limits })).rejects.toBeInstanceOf(ArchiveLimitError)
})
```

Fixtures must be real ZIPs with central directory metadata; keep a checked-in fixture README listing each entry name, Unix mode and compressed/uncompressed size.

- [ ] **Step 2: Verify tests fail before the ZIP boundary exists**

Run: `cd packages/core && bun test test/skill/zip.test.ts`

Expected: FAIL for missing `src/skill/zip.ts`.

- [ ] **Step 3: Add direct ZIP dependencies and tagged errors**

Run: `cd packages/core && bun add yauzl@2.10.0 && bun add -d @types/yauzl@2.10.3`

Expected: Core `package.json` and root `bun.lock` record direct dependencies.

```ts
export type ZipLimits = { archiveBytes: number; extractedBytes: number; files: number; ratio: number }
export type ZipFile = { path: string; compressedSize: number; size: number; mode: number }
export type ZipManifest = { files: readonly ZipFile[]; compressedSize: number; extractedSize: number }
export class UnsafeArchiveError extends Schema.TaggedErrorClass<UnsafeArchiveError>()("UnsafeArchiveError", { path: Schema.String, reason: Schema.String }) {}
export class ArchiveLimitError extends Schema.TaggedErrorClass<ArchiveLimitError>()("ArchiveLimitError", { limit: Schema.Literals(["archiveBytes", "extractedBytes", "files", "ratio"]), actual: Schema.Number }) {}
```

- [ ] **Step 4: Implement central-directory preflight and bounded extraction**

For every entry, normalize `/`, reject `\\`, NUL, URL-like names, empty segments, `.`, `..`, POSIX/Windows absolute paths, drive letters and any resolved path outside staging. Read Unix mode from `externalFileAttributes >>> 16`; reject `0o120000` symlinks and non-regular/non-directory entry types. Parse extra fields and reject Info-ZIP Unix field `0x000d` when it carries link metadata, covering hard-link archives. Reject entries with duplicate normalized paths. Sum count/compressed/uncompressed values before opening output files.

```ts
function safeDestination(root: string, name: string) {
  const normalized = path.posix.normalize(name)
  if (name.includes("\\") || normalized !== name || normalized.split("/").some((part) => !part || part === "." || part === ".."))
    throw new UnsafeArchiveError({ path: name, reason: "invalid-path" })
  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /^[a-z]:/i.test(name))
    throw new UnsafeArchiveError({ path: name, reason: "absolute-path" })
  const destination = path.resolve(root, ...name.split("/"))
  if (!FSUtil.contains(root, destination) || destination === root)
    throw new UnsafeArchiveError({ path: name, reason: "path-traversal" })
  return destination
}
```

During extraction, create files with `wx`, cap bytes read per entry at the advertised size, cap aggregate bytes again, and remove staging on every error. Do not shell out to `unzip`, PowerShell or platform-specific tools.

- [ ] **Step 5: Run archive security tests and Core typecheck**

Run: `cd packages/core && bun test test/skill/zip.test.ts && bun typecheck`

Expected: all valid/attack/limit tests pass on macOS; CI Windows runs the same fixtures and assertions.

- [ ] **Step 6: Commit archive security**

```bash
git add packages/core/package.json packages/core/src/skill/zip.ts packages/core/test/skill/zip.test.ts packages/core/test/fixtures/skill-market bun.lock
git commit -m "feat(core): validate skill market archives"
```

### Task 3: Implement transactional global installation and offline inventory

**Files:**
- Create: `packages/core/src/skill/market-installer.ts`
- Modify: `packages/core/src/location-services.ts`
- Create: `packages/core/test/skill/market-installer.test.ts`

**Interfaces:**
- Consumes: trusted `SkillMarket.Detail`, `SkillMarket.InstallRequest`, `Global.Service.config`, `FSUtil.Service`, `SkillV2.Service`, ZIP boundary from Task 2.
- Produces: `SkillMarketInstaller.Service` methods `install`, `update`, `uninstall`, `installed`, `refresh`; all operations key by `{ source, id }`.

- [ ] **Step 1: Write transactional installer tests**

```ts
test("installs globally, writes an ownership manifest and reloads without restart", async () => {
  await using env = await installerEnvironment({ package: fixtureServer("valid.zip") })
  const result = await env.install(sampleDetail(), sampleRequest())
  expect(result.changed).toBe(true)
  expect(await Bun.file(`${env.config}/skills/code-review/SKILL.md`).exists()).toBe(true)
  expect((await env.skills()).map((skill) => skill.name)).toContain("code-review")
  expect((await env.installed())[0]?.version).toBe("1.0.0")
})

test("restores the old version when atomic replacement fails", async () => {
  await using env = await installerEnvironment({ renameFailure: "staging-to-target" })
  await env.seedInstalled("1.0.0", "old")
  await expect(env.update(sampleDetail({ version: "2.0.0" }), sampleRequest({ version: "2.0.0" }))).rejects.toThrow()
  expect(await Bun.file(`${env.target}/SKILL.md`).text()).toContain("old")
})
```

Add exact retry/no-op, hash mismatch, risk missing confirmation, download interruption, package too large, invalid frontmatter/name, concurrent same-key serialization, four-key concurrency cap, refresh failure result, uninstall ownership guard, and offline inventory tests.

- [ ] **Step 2: Verify installer tests fail**

Run: `cd packages/core && bun test test/skill/market-installer.test.ts`

Expected: FAIL for missing `SkillMarketInstaller.Service`.

- [ ] **Step 3: Define manifest, errors and service methods**

```ts
const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: SkillMarket.Source,
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  sha256: SkillMarket.Sha256,
  installedAt: Schema.DateTimeUtcFromString,
  sourceUrl: SkillMarket.HttpsUrl,
})

export interface Interface {
  readonly install: (detail: SkillMarket.Detail, request: SkillMarket.InstallRequest) => Effect.Effect<SkillMarket.OperationResult, Error>
  readonly update: (detail: SkillMarket.Detail, request: SkillMarket.InstallRequest) => Effect.Effect<SkillMarket.OperationResult, Error>
  readonly uninstall: (key: { source: SkillMarket.Source; id: string }) => Effect.Effect<void, Error>
  readonly installed: () => Effect.Effect<SkillMarket.Installed[], Error>
  readonly refresh: (key: { source: SkillMarket.Source; id: string }) => Effect.Effect<void, Error>
}
```

Stable tagged error codes are `network-unavailable`, `skill-delisted`, `risk-confirmation-required`, `hash-mismatch`, `unsafe-archive`, `archive-limit`, `invalid-skill`, `disk-unavailable`, `version-conflict`, `not-market-owned`, and `refresh-failed`.

- [ ] **Step 4: Implement download, verify, stage and atomic replace**

Target names use the exact validated `id`, producing `path.join(global.config, "skills", detail.id)` after rejecting `.`, `..`, path separators, drive prefixes, URL-like IDs and NUL. Locks are keyed by `id`, so two sources with the same ID cannot race for one target; installing a different source over an owned target returns `version-conflict`. Download to `skills/.staging/<uuid>/package.zip`, abort after 50 MiB, calculate SHA-256 while streaming, compare request hash, detail hash and actual hash, then extract beside target. Require exactly one root `SKILL.md` after stripping one common archive folder, parse with `ConfigMarkdown`, and require `frontmatter.name === detail.id`. The backend must therefore normalize a SkillHub entry ID from its verified package frontmatter before publishing it.

Atomic update sequence:

```ts
yield* Effect.uninterruptible(
  Effect.gen(function* () {
    const exists = yield* fs.exists(target)
    if (exists) yield* fs.rename(target, backup)
    yield* fs.rename(stagingSkill, target).pipe(
      Effect.catch((error) => Effect.gen(function* () {
        if (exists) yield* fs.rename(backup, target).pipe(Effect.ignore)
        return yield* Effect.fail(error)
      })),
    )
    if (exists) yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
  }),
)
```

After commit, call `skill.reload()`. If reload fails, keep files and return `loadState: "refresh-failed"`; `refresh()` retries only reload. Always remove staging/backup debris in ensuring blocks without deleting the active target.

- [ ] **Step 5: Register the service in Location dependencies**

Add `SkillMarketInstaller.node` to `packages/core/src/location-services.ts`; its node depends on `Global.node`, `FSUtil.node`, `SkillV2.node` and the platform HTTP client. Do not make App depend on this service.

- [ ] **Step 6: Run installer and Core regression tests**

Run: `cd packages/core && bun test test/skill/market-installer.test.ts test/skill/zip.test.ts test/skill/reload.test.ts && bun typecheck`

Expected: every install/update/rollback/security/offline test passes and Core typechecks.

- [ ] **Step 7: Commit the installer service**

```bash
git add packages/core/src/skill/market-installer.ts packages/core/src/location-services.ts packages/core/test/skill/market-installer.test.ts
git commit -m "feat(core): install global market skills"
```

### Task 4: Add remote proxy and local Desktop HttpApi

**Files:**
- Create: `packages/protocol/src/groups/skill-market-local.ts`
- Modify: `packages/protocol/src/api.ts`
- Create: `packages/server/src/skill-market/catalog.ts`
- Create: `packages/server/src/handlers/skill-market.ts`
- Modify: `packages/server/src/handlers.ts`
- Modify: `packages/server/package.json`
- Create: `packages/server/test/skill-market.test.ts`

**Interfaces:**
- Consumes: `SkillMarketInstaller.Service`, remote `SkillMarketCatalogApi`, OEM market URL/allowed hosts, local Location middleware.
- Produces: approved `/api/skill/market/*` endpoints plus the list UI's facet proxy, `SkillMarketLocalError`, and catalog cache at `Global.Service.cache/skill-market/catalog.json`.

Import `SkillMarketCatalogQuery` and `normalizeSkillMarketCatalogQuery` from `@opencode-ai/protocol/groups/skill-market-catalog`; use the transport schema on the local list endpoint and normalize `ctx.query` before passing it to the catalog service.

- [ ] **Step 1: Write local API tests against real HTTP layers**

```ts
test("revalidates remote detail and rejects warning install without confirmation", async () => {
  const client = await localMarketClient({ detail: sampleDetail({ risk: "warning" }) })
  const denied = await client.post("/api/skill/market/install", sampleRequest({ riskConfirmed: false }))
  expect(denied.status).toBe(409)
  expect((await denied.json()).code).toBe("risk-confirmation-required")
  const installed = await client.post("/api/skill/market/install", sampleRequest({ riskConfirmed: true }))
  expect(installed.status).toBe(200)
})
```

Add list status merge, detail proxy, installed/update endpoints, offline installed/uninstall, delisted rejection, request/detail version/hash mismatch, allowed-host redirect rejection, stable error code and cache fallback tests.

- [ ] **Step 2: Verify local API tests fail**

Run: `cd packages/server && bun test test/skill-market.test.ts`

Expected: FAIL because the local group/handler do not exist.

- [ ] **Step 3: Define the local group and error contract**

```ts
export class SkillMarketUnavailableError extends Schema.ErrorClass<SkillMarketUnavailableError>("SkillMarketUnavailableError")({
  code: Schema.Literals(["network-unavailable", "market-unavailable"]),
  message: Schema.String,
}, { httpApiStatus: 503 }) {}
export class SkillMarketConflictError extends Schema.ErrorClass<SkillMarketConflictError>("SkillMarketConflictError")({
  code: Schema.Literals(["skill-delisted", "risk-confirmation-required", "hash-mismatch", "version-conflict", "not-market-owned"]),
  message: Schema.String,
}, { httpApiStatus: 409 }) {}
export class SkillMarketOperationError extends Schema.ErrorClass<SkillMarketOperationError>("SkillMarketOperationError")({
  code: Schema.Literals(["unsafe-archive", "archive-limit", "invalid-skill", "disk-unavailable", "refresh-failed"]),
  message: Schema.String,
}, { httpApiStatus: 422 }) {}
export const SkillMarketLocalError = Schema.Union([SkillMarketUnavailableError, SkillMarketConflictError, SkillMarketOperationError])
export type SkillMarketLocalError = typeof SkillMarketLocalError.Type

export const SkillMarketLocalGroup = HttpApiGroup.make("server.skillMarket")
  .add(HttpApiEndpoint.get("skillMarket.list", "/api/skill/market/skills", { query: SkillMarketCatalogQuery, success: SkillMarket.Page, error: SkillMarketLocalError }))
  .add(HttpApiEndpoint.get("skillMarket.facets", "/api/skill/market/facets", { success: SkillMarket.Facets, error: SkillMarketLocalError }))
  .add(HttpApiEndpoint.get("skillMarket.detail", "/api/skill/market/skills/:source/:id", { params: Key, success: SkillMarket.Detail, error: SkillMarketLocalError }))
  .add(HttpApiEndpoint.get("skillMarket.installed", "/api/skill/market/installed", { success: Schema.Array(SkillMarket.Installed), error: SkillMarketLocalError }))
  .add(HttpApiEndpoint.get("skillMarket.updates", "/api/skill/market/updates", { success: Schema.Array(SkillMarket.Installed), error: SkillMarketLocalError }))
  .add(HttpApiEndpoint.post("skillMarket.install", "/api/skill/market/install", { payload: SkillMarket.InstallRequest, success: SkillMarket.OperationResult, error: SkillMarketLocalError }))
  .add(HttpApiEndpoint.post("skillMarket.update", "/api/skill/market/update", { payload: SkillMarket.InstallRequest, success: SkillMarket.OperationResult, error: SkillMarketLocalError }))
  .add(HttpApiEndpoint.delete("skillMarket.uninstall", "/api/skill/market/install/:source/:id", { params: Key, success: HttpApiSchema.NoContent, error: SkillMarketLocalError }))
  .add(HttpApiEndpoint.post("skillMarket.refresh", "/api/skill/market/install/:source/:id/refresh", { params: Key, success: HttpApiSchema.NoContent, error: SkillMarketLocalError }))
```

Add the group to `makeApiFromGroup` with Location middleware because installer/Global/Skill services are Location-scoped.

- [ ] **Step 4: Implement the remote catalog proxy and status merge**

`catalog.ts` fetches only `RUYING_SKILL_MARKET_API_URL`, validates HTTPS and final redirect host, decodes every response with Task 1 schemas, caches the last successful page/facets/detail metadata via atomic rename, and never caches sanitized HTML. `list` merges installed manifests by `(source,id)` and sets `installedVersion/updateAvailable`; `updates` compares versions from remote metadata and returns a stable network error when unavailable.

- [ ] **Step 5: Bind handlers and revalidate every mutation**

```ts
handlers.handle("skillMarket.install", (ctx) =>
  Effect.gen(function* () {
    const catalog = yield* SkillMarketCatalog.Service
    const installer = yield* SkillMarketInstaller.Service
    const detail = yield* catalog.detail({ source: ctx.payload.source, id: ctx.payload.id })
    if (detail.delisted) return yield* new SkillMarketConflictError({ code: "skill-delisted", message: "Skill 已下架" })
    if (detail.version !== ctx.payload.version || detail.package.sha256 !== ctx.payload.sha256)
      return yield* new SkillMarketConflictError({ code: "version-conflict", message: "目录版本已变化，请刷新后重试" })
    return yield* installer.install(detail, ctx.payload).pipe(Effect.mapError(toLocalError))
  }),
)
```

Update uses the same remote revalidation. Uninstall and refresh do not access the network. Map every Core tagged error to the exact protocol code; do not return raw filesystem/network exception messages.

- [ ] **Step 6: Run Protocol and Server tests/typechecks**

Run: `cd packages/protocol && bun typecheck`

Expected: Protocol typechecks.

Run: `cd packages/server && bun test test/skill-market.test.ts && bun typecheck`

Expected: local API and proxy tests pass; Server typechecks.

- [ ] **Step 7: Commit local API**

```bash
git add packages/protocol/src/groups/skill-market-local.ts packages/protocol/src/api.ts packages/server/src/skill-market/catalog.ts packages/server/src/handlers/skill-market.ts packages/server/src/handlers.ts packages/server/package.json packages/server/test/skill-market.test.ts
git commit -m "feat(server): expose skill market installer api"
```

### Task 5: Generate clients and run cross-package acceptance

**Files:**
- Modify generated by command: `packages/client/src/generated/`
- Modify generated by command: `packages/client/src/generated-effect/`
- Create: `packages/client/test/skill-market.test.ts`
- Create: `packages/core/test/skill/market-acceptance.test.ts`

**Interfaces:**
- Consumes: the public Server `HttpApi` after Task 4.
- Produces: generated SDK methods for all nine local endpoints and an end-to-end no-restart install test.

- [ ] **Step 1: Generate the client from the public API**

Run: `cd packages/client && bun run generate`

Expected: generated JS/Effect clients contain `skillMarket.list`, `facets`, `detail`, `installed`, `updates`, `install`, `update`, `uninstall`, and `refresh`; no generated file was hand-edited.

- [ ] **Step 2: Add generated client shape test**

```ts
test("generated client exposes all local skill market operations", () => {
  const client = createClient({ baseUrl: "http://127.0.0.1:1" })
  expect(Object.keys(client.skillMarket).toSorted()).toEqual(["detail", "facets", "install", "installed", "list", "refresh", "uninstall", "update", "updates"])
})
```

- [ ] **Step 3: Add no-restart acceptance test**

Start a real local catalog/package fixture server, build the real Location layer, call the generated install operation, then call the existing `skill.list` operation in the same server process and assert the new name/content is returned. Call uninstall and assert the next list no longer includes it. No process restart, manual cache edit or mocked Skill service is allowed.

- [ ] **Step 4: Run final installer gate**

Run: `cd packages/client && bun test test/skill-market.test.ts && bun typecheck && bun run check:generated`

Expected: client test/typecheck pass and generated diff check is clean after regeneration.

Run: `cd packages/core && bun test test/skill/market-acceptance.test.ts test/skill/market-installer.test.ts test/skill/zip.test.ts && bun typecheck`

Expected: install/list/uninstall works in one process; all Core tests pass.

Run: `cd packages/server && bun test test/skill-market.test.ts && bun typecheck`

Expected: all local API tests pass.

- [ ] **Step 5: Commit generated clients and acceptance**

```bash
git add packages/client/src/generated packages/client/src/generated-effect packages/client/test/skill-market.test.ts packages/core/test/skill/market-acceptance.test.ts
git commit -m "test(skill-market): verify local installation flow"
```

## Plan Completion Gate

- Every mutation refetches and decodes remote detail; no request payload contains or controls a download URL.
- A warning/danger/unknown Skill without confirmation is rejected server-side even if UI checks are bypassed.
- Malicious ZIP fixtures never create a path outside staging and never leave a partial target.
- Failed updates retain the exact old `SKILL.md` and manifest; failed refresh retains installed files with `refresh-failed` state.
- Offline installed/uninstall/refresh work from `.ruying-market.json`; offline catalog/update checks return stable errors.
- Existing manually managed Skill directories remain untouched by uninstall.
