# Skill 市场同源安装包交付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让市场 API 直接交付已同步并校验的 Skill ZIP，使安装提示词和浏览器下载都不再访问带自签名证书链的 OSS 地址。

**Architecture:** Protocol 增加 GET/HEAD 二进制包端点，服务端包读取器只根据已解析的目录详情构造公共 ObjectStore 键，在完整读取、大小校验和 SHA-256 校验后返回响应。Web 从运行时 API base URL 生成唯一 `/package` 地址，同时用于安装提示词和下载按钮；现有 `/download` JSON 端点保留兼容。

**Tech Stack:** TypeScript、Bun、Effect HttpApi、AWS S3-compatible ObjectStore、SolidJS、Playwright

## Global Constraints

- 单包上限严格为 `50 * 1024 * 1024` 字节。
- 不接受、解析或代理客户端提供的任意上游 URL；不得用 `detail.package.url` 定位对象。
- SkillHub/企业对象键为 `<public-prefix>/packages/<sha256>.zip`；社区对象键复用 `communityPackageKey(...)`。
- GET 与 HEAD 都必须在成功响应前完成对象存在性、长度和 SHA-256 校验。
- 第一版不实现 Range、断点续传、条件请求、本地磁盘缓存或数据库缓存。
- 保留 `/v1/catalog/skills/:source/:id/download` JSON 端点以兼容已有客户端。
- Protocol 或 Server `HttpApi` 变更后，从 `packages/client` 执行 `bun run generate`；不得手工编辑 `src/generated` 或 `src/generated-effect`。
- 测试和 `bun typecheck` 必须从具体 package 目录运行，不能从仓库根目录运行。
- 当前工作区已有其他未提交改动。每次只暂存本任务列出的路径，先检查 `git diff -- <path>` 并合并现有内容，禁止覆盖或回退无关改动。

---

## File Map

| File | Responsibility |
| --- | --- |
| `packages/protocol/src/groups/skill-market-catalog.ts` | 声明 GET/HEAD 包端点和 404/413/502 错误契约 |
| `packages/protocol/test/skill-market-catalog.test.ts` | 验证公开端点集合和 HTTP 方法 |
| `packages/client/src/generated/**` | 由生成器产生的普通客户端变更 |
| `packages/client/src/generated-effect/**` | 由生成器产生的 Effect 客户端变更 |
| `packages/skill-market-server/src/package-reader.ts` | 构造可信对象键并校验包大小与 SHA-256 |
| `packages/skill-market-server/test/package-reader.test.ts` | 包读取器的来源、上限、缺失和完整性测试 |
| `packages/skill-market-server/src/http/catalog.ts` | 将 Protocol 包端点接到包读取器并构造二进制响应 |
| `packages/skill-market-server/src/handlers.ts` | 注入公共 prefix，并使遗留 Web handler 遵循相同契约 |
| `packages/skill-market-server/src/server.ts` | 将 `config.ossPrefix` 注入市场路由 |
| `packages/skill-market-server/test/http.test.ts` | GET/HEAD、响应头、状态码和 URL 隔离测试 |
| `packages/skill-market-server/test/control-http.test.ts` | 更新完整路由测试夹具的公共 prefix |
| `packages/app/src/skill-market/types.ts` | Web action 传递已生成 prompt 字符串 |
| `packages/app/src/skill-market/detail.tsx` | 统一自动复制与手动复制的提示词 |
| `packages/app/src/skill-market/detail.test.tsx` | 验证提示词包含内网详情、包地址和校验要求 |
| `packages/skill-market-web/src/runtime-config.ts` | 生成详情页 URL 和 API `/package` URL |
| `packages/skill-market-web/src/runtime-config.test.ts` | 验证默认/显式 API base URL 与 ID 编码 |
| `packages/skill-market-web/src/app.tsx` | 提示词和下载按钮统一使用 `/package` |
| `packages/skill-market-web/e2e/fixtures/server.ts` | 提供测试 ZIP 包端点 |
| `packages/skill-market-web/e2e/market.e2e.ts` | 验证复制内容和浏览器下载请求 |

---

### Task 1: Protocol contract and generated clients

**Files:**
- Modify: `packages/protocol/src/groups/skill-market-catalog.ts`
- Modify: `packages/protocol/test/skill-market-catalog.test.ts`
- Regenerate: `packages/client/src/generated/**`
- Regenerate: `packages/client/src/generated-effect/**`

**Interfaces:**
- Consumes: existing `Key`, `SkillMarket.Source`, `SkillMarket.Sha256`
- Produces: endpoint IDs `skillMarket.catalog.package` and `skillMarket.catalog.packageHead`; error classes `SkillMarketPackageNotFound`, `SkillMarketPackageTooLarge`, `SkillMarketPackageUnavailable`

- [ ] **Step 1: Extend the reflection test and verify red**

Update the expected endpoint set and also collect methods:

```ts
test("catalog api contains package GET and HEAD operations", () => {
  const endpoints: Array<{ name: string; method: string }> = []
  HttpApi.reflect(SkillMarketCatalogApi, {
    onGroup() {},
    onEndpoint({ endpoint }) {
      endpoints.push({ name: endpoint.name, method: endpoint.method })
    },
  })
  expect(endpoints.toSorted((left, right) => left.name.localeCompare(right.name))).toEqual([
    { name: "skillMarket.catalog.detail", method: "GET" },
    { name: "skillMarket.catalog.download", method: "GET" },
    { name: "skillMarket.catalog.facets", method: "GET" },
    { name: "skillMarket.catalog.list", method: "GET" },
    { name: "skillMarket.catalog.package", method: "GET" },
    { name: "skillMarket.catalog.packageHead", method: "HEAD" },
    { name: "skillMarket.catalog.versions", method: "GET" },
  ])
})
```

Run from `packages/protocol`:

```sh
bun test test/skill-market-catalog.test.ts
```

Expected: FAIL because the two package endpoints are absent.

- [ ] **Step 2: Add package error schemas and endpoints**

Import `HttpApiSchema`, then add package-specific public errors:

```ts
const packageProblem = <Code extends string>(code: Code) => ({
  code: Schema.Literal(code),
  message: Schema.String,
  requestId: Schema.String,
  source: SkillMarket.Source,
  id: Schema.String,
})

export class SkillMarketPackageNotFound extends Schema.ErrorClass<SkillMarketPackageNotFound>(
  "SkillMarketPackageNotFound",
)(packageProblem("skill-market-not-found"), { httpApiStatus: 404 }) {}

export class SkillMarketPackageTooLarge extends Schema.ErrorClass<SkillMarketPackageTooLarge>(
  "SkillMarketPackageTooLarge",
)(packageProblem("skill-market-package-too-large"), { httpApiStatus: 413 }) {}

export class SkillMarketPackageUnavailable extends Schema.ErrorClass<SkillMarketPackageUnavailable>(
  "SkillMarketPackageUnavailable",
)(packageProblem("skill-market-package-unavailable"), { httpApiStatus: 502 }) {}

const PackageErrors = Schema.Union([
  SkillMarketPackageNotFound,
  SkillMarketPackageTooLarge,
  SkillMarketPackageUnavailable,
])
```

Add both operations after the existing `/download` endpoint:

```ts
.add(
  HttpApiEndpoint.get("skillMarket.catalog.package", "/v1/catalog/skills/:source/:id/package", {
    params: Key,
    success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    error: PackageErrors,
  }),
)
.add(
  HttpApiEndpoint.head("skillMarket.catalog.packageHead", "/v1/catalog/skills/:source/:id/package", {
    params: Key,
    success: HttpApiSchema.Empty(200),
    error: PackageErrors,
  }),
)
```

- [ ] **Step 3: Run Protocol tests and typecheck**

From `packages/protocol`:

```sh
bun test test/skill-market-catalog.test.ts
bun typecheck
```

Expected: both commands exit 0; reflection reports seven operations.

- [ ] **Step 4: Regenerate both clients**

From `packages/client`:

```sh
bun run generate
bun test test/contract-identity.test.ts
bun typecheck
```

Expected: generator changes only generated client trees, tests pass, and typecheck exits 0. Inspect generated methods and confirm both package operations use the declared paths/methods.

- [ ] **Step 5: Commit the Protocol unit**

```sh
git add packages/protocol/src/groups/skill-market-catalog.ts \
  packages/protocol/test/skill-market-catalog.test.ts \
  packages/client/src/generated \
  packages/client/src/generated-effect
git diff --cached --check
git commit -m "feat(protocol): add catalog package endpoints"
```

---

### Task 2: Trusted package reader

**Files:**
- Create: `packages/skill-market-server/src/package-reader.ts`
- Create: `packages/skill-market-server/test/package-reader.test.ts`

**Interfaces:**
- Consumes: `ObjectStore`, `SkillMarket.Detail`, `communityPackageKey(prefix, id, version, sha256)`
- Produces:

```ts
export const MAX_CATALOG_PACKAGE_SIZE = 50 * 1024 * 1024
export type CatalogPackageReader = ReturnType<typeof createCatalogPackageReader>
export class CatalogPackageReadError extends Error {
  readonly kind: "too-large" | "unavailable"
  readonly phase: "declared-size" | "head" | "stored-size" | "get" | "body-size" | "sha256"
}
export function createCatalogPackageReader(store: ObjectStore, publicPrefix: string): {
  read(detail: SkillMarket.Detail): Promise<{
    body: Uint8Array
    sha256: string
    size: number
  }>
}
```

- [ ] **Step 1: Write reader tests for trusted key resolution**

Create a memory `ObjectStore` that records every `head/get` key. Use real body hashes:

```ts
const body = new TextEncoder().encode("verified zip fixture")
const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
const detail = sampleDetail({
  package: {
    ...sampleDetail().package,
    url: "https://attacker.example/never-request-this.zip",
    sha256,
    size: body.byteLength,
  },
})
```

Assert:

```ts
expect(await reader.read(detail)).toEqual({ body, sha256, size: body.byteLength })
expect(store.reads).toEqual([
  `public-market/packages/${sha256}.zip`,
  `public-market/packages/${sha256}.zip`,
])
expect(store.reads.join("\n")).not.toContain("attacker.example")
```

Add a community detail and assert both reads use:

```text
public-market/packages/community/code-review/1.0.0/<sha256>.zip
```

Run from `packages/skill-market-server`:

```sh
bun test test/package-reader.test.ts
```

Expected: FAIL because `package-reader.ts` does not exist.

- [ ] **Step 2: Write failure tests**

Add separate tests that assert `CatalogPackageReadError.kind`:

```ts
await expect(reader.read(detailWithSize(MAX_CATALOG_PACKAGE_SIZE + 1))).rejects.toMatchObject({
  kind: "too-large",
  phase: "declared-size",
})
await expect(readerForHeadSize(MAX_CATALOG_PACKAGE_SIZE + 1).read(detail)).rejects.toMatchObject({
  kind: "too-large",
  phase: "stored-size",
})
await expect(readerForMissingObject().read(detail)).rejects.toMatchObject({
  kind: "unavailable",
  phase: "head",
})
await expect(readerForHeadSize(body.byteLength + 1).read(detail)).rejects.toMatchObject({
  kind: "unavailable",
  phase: "stored-size",
})
await expect(readerForBody(new TextEncoder().encode("tampered")).read(detail)).rejects.toMatchObject({
  kind: "unavailable",
  phase: "sha256",
})
```

Cover these distinct cases: declared oversize, HEAD oversize, missing HEAD, missing GET, HEAD/detail length mismatch, GET/HEAD length mismatch, and SHA mismatch.

- [ ] **Step 3: Implement key construction and verify-before-return**

Implement the reader without using `detail.package.url`:

```ts
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { communityPackageKey } from "./community"
import type { ObjectStore } from "./oss"

export const MAX_CATALOG_PACKAGE_SIZE = 50 * 1024 * 1024

type CatalogPackageReadPhase = "declared-size" | "head" | "stored-size" | "get" | "body-size" | "sha256"

export class CatalogPackageReadError extends Error {
  constructor(
    readonly kind: "too-large" | "unavailable",
    readonly phase: CatalogPackageReadPhase,
  ) {
    super(`catalog package ${kind} during ${phase}`)
    this.name = "CatalogPackageReadError"
  }
}

export function createCatalogPackageReader(store: ObjectStore, publicPrefix: string) {
  return {
    async read(detail: SkillMarket.Detail) {
      if (detail.package.size > MAX_CATALOG_PACKAGE_SIZE)
        throw new CatalogPackageReadError("too-large", "declared-size")
      const objectKey =
        detail.source === "community"
          ? communityPackageKey(publicPrefix, detail.id, detail.version, detail.package.sha256)
          : `${publicPrefix.replace(/^\\/+|\\/+$/g, "")}/packages/${detail.package.sha256}.zip`
      const metadata = await store.head(objectKey).catch(() => {
        throw new CatalogPackageReadError("unavailable", "head")
      })
      if (metadata.size > MAX_CATALOG_PACKAGE_SIZE)
        throw new CatalogPackageReadError("too-large", "stored-size")
      if (metadata.size !== detail.package.size)
        throw new CatalogPackageReadError("unavailable", "stored-size")
      const body = await store.get(objectKey).catch(() => {
        throw new CatalogPackageReadError("unavailable", "get")
      })
      if (body.byteLength !== metadata.size || body.byteLength !== detail.package.size)
        throw new CatalogPackageReadError("unavailable", "body-size")
      const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
      if (sha256 !== detail.package.sha256)
        throw new CatalogPackageReadError("unavailable", "sha256")
      return { body, sha256, size: body.byteLength }
    },
  }
}

export type CatalogPackageReader = ReturnType<typeof createCatalogPackageReader>
```

- [ ] **Step 4: Run focused and package verification**

From `packages/skill-market-server`:

```sh
bun test test/package-reader.test.ts
bun typecheck
```

Expected: all reader cases pass and typecheck exits 0.

- [ ] **Step 5: Commit the reader**

```sh
git add packages/skill-market-server/src/package-reader.ts \
  packages/skill-market-server/test/package-reader.test.ts
git diff --cached --check
git commit -m "feat(skill-market): verify catalog packages"
```

---

### Task 3: Server HTTP delivery

**Files:**
- Modify: `packages/skill-market-server/src/http/catalog.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`
- Modify: `packages/skill-market-server/test/http.test.ts`
- Modify: `packages/skill-market-server/test/control-http.test.ts`

**Interfaces:**
- Consumes: `CatalogPackageReader.read(detail)` from Task 2 and package error schemas from Task 1
- Produces: verified GET/HEAD responses and `MarketHttpOptions.publicPrefix: string`

- [ ] **Step 1: Add failing GET and HEAD handler tests**

In `test/http.test.ts`, build a package fixture whose catalog SHA matches its bytes, inject `createCatalogPackageReader(store, "public-market")`, and assert:

```ts
const get = await handler(
  new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/package"),
)
expect(get.status).toBe(200)
expect(new Uint8Array(await get.arrayBuffer())).toEqual(body)
expect(get.headers.get("content-type")).toBe("application/zip")
expect(get.headers.get("content-length")).toBe(String(body.byteLength))
expect(get.headers.get("etag")).toBe(`"${sha256}"`)
expect(get.headers.get("x-content-sha256")).toBe(sha256)
expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
expect(get.headers.get("content-disposition")).toBe(
  'attachment; filename="skillhub-code-review-1.0.0.zip"',
)

const head = await handler(
  new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/package", {
    method: "HEAD",
  }),
)
expect(head.status).toBe(200)
expect(await head.text()).toBe("")
expect(head.headers.get("x-content-sha256")).toBe(sha256)
expect(store.getCalls).toBe(2)
```

The final assertion proves HEAD also reads and verifies the body.

Run from `packages/skill-market-server`:

```sh
bun test test/http.test.ts
```

Expected: FAIL because `/package` is not routed.

- [ ] **Step 2: Add failing status and isolation tests**

Add table-driven cases:

- absent and delisted detail return 404 without `head/get`;
- declared or stored oversize returns 413;
- object missing, length mismatch, and SHA mismatch return 502;
- snapshot load failure returns the existing 503 `market-unavailable` problem;
- `package.url` set to a canary URL is never fetched and never used as an object key;
- encoded IDs cannot escape the public prefix.

Assert the JSON codes exactly:

```ts
expect(await response.json()).toMatchObject({
  code: "skill-market-package-unavailable",
  source: "skillhub",
  id: "code-review",
  requestId: expect.any(String),
})
```

Capture the injected metric emitter and assert one success metric for a valid response and one failure metric whose `request_id` equals the public problem’s `requestId`; assert the metric contains the failure phase but no object key or OSS URL.

- [ ] **Step 3: Add the Effect HttpApi package handlers**

Change `createCatalogHttp` to accept a reader and the existing metric emitter:

```ts
export function createCatalogHttp(
  loadSnapshot: SnapshotLoader,
  packages: CatalogPackageReader,
  emit?: MarketMetricEmitter,
)
```

Register both raw handlers:

```ts
.handleRaw("skillMarket.catalog.package", (context) =>
  packageResponse(loadSnapshot, packages, context.params.source, context.params.id, false),
)
.handleRaw("skillMarket.catalog.packageHead", (context) =>
  packageResponse(loadSnapshot, packages, context.params.source, context.params.id, true),
)
```

`packageResponse` must:

1. load the current snapshot;
2. resolve a non-delisted detail;
3. await `packages.read(detail)`;
4. map `too-large` to 413 and every other reader failure to 502;
5. create one `requestID()` for an error response and its metric, without exposing object keys or SDK errors;
6. emit `skill_market_package_delivery` success/failure metrics with `source`, `id`, method, and failure phase;
7. return `HttpServerResponse.uint8Array` for GET or `HttpServerResponse.empty` for HEAD;
8. set the exact headers from the design.

The metric shape is:

```ts
emit?.({
  skill_market_package_delivery: {
    failure: 1,
    source,
    id,
    method: head ? "HEAD" : "GET",
    phase: error.phase,
    request_id: requestId,
  },
})
```

On success emit the same object with `success: 1`, without `phase` or `request_id`. The public JSON problem contains the same `requestId` used in the failure metric.

Use this header builder for both methods:

```ts
function packageHeaders(detail: SkillMarket.Detail, verified: { sha256: string; size: number }) {
  const filename = `${detail.source}-${detail.id}-${detail.version}.zip`.replace(/[^a-zA-Z0-9._-]/g, "_")
  return {
    "cache-control": "public, max-age=31536000, immutable",
    "content-disposition": `attachment; filename="${filename}"`,
    "content-length": String(verified.size),
    "content-type": "application/zip",
    etag: `"${verified.sha256}"`,
    "x-content-sha256": verified.sha256,
  }
}
```

Do not route package responses through the existing 60-second snapshot ETag pre-response handler, because it would replace the content-addressed ETag.

- [ ] **Step 4: Wire the store and public prefix**

Extend `MarketHttpOptions`:

```ts
readonly publicPrefix: string
```

Inside `createMarketRoutes`, construct one reader:

```ts
const packages = createCatalogPackageReader(options.store, options.publicPrefix)
```

Pass it to `createCatalogHttp(options.loadSnapshot, packages, options.emit)`. The separately exported legacy `createCatalogHandler` receives the same reader when tests or standalone callers use it. In `server.ts` add:

```ts
publicPrefix: config.ossPrefix,
```

Update every `createMarketWebHandler` test fixture, including `test/control-http.test.ts`, with:

```ts
publicPrefix: "skill-market",
```

- [ ] **Step 5: Keep the legacy handler behavior aligned**

Change the legacy signature to:

```ts
export function createCatalogHandler(loadSnapshot: SnapshotLoader, packages?: CatalogPackageReader)
```

Make its `route(...)` async only for `/package`; all existing JSON routes remain unchanged. If no package reader is injected, `/package` returns the same 502 JSON problem rather than attempting an upstream URL. Use the same `packageHeaders` and error mapping as the Effect handler; extract only genuinely shared response construction, not single-use helpers.

- [ ] **Step 6: Run server tests and typecheck**

From `packages/skill-market-server`:

```sh
bun test test/package-reader.test.ts test/http.test.ts test/control-http.test.ts
bun test
bun typecheck
```

Expected: focused tests pass, the full server suite passes, and typecheck exits 0.

- [ ] **Step 7: Commit HTTP delivery**

```sh
git add packages/skill-market-server/src/http/catalog.ts \
  packages/skill-market-server/src/handlers.ts \
  packages/skill-market-server/src/server.ts \
  packages/skill-market-server/test/http.test.ts \
  packages/skill-market-server/test/control-http.test.ts
git diff --cached --check
git commit -m "feat(skill-market): serve verified packages"
```

---

### Task 4: Web prompt and download convergence

**Files:**
- Modify: `packages/app/src/skill-market/types.ts`
- Modify: `packages/app/src/skill-market/detail.tsx`
- Modify: `packages/app/src/skill-market/detail.test.tsx`
- Modify: `packages/skill-market-web/src/runtime-config.ts`
- Modify: `packages/skill-market-web/src/runtime-config.test.ts`
- Modify: `packages/skill-market-web/src/app.tsx`
- Modify: `packages/skill-market-web/e2e/fixtures/server.ts`
- Modify: `packages/skill-market-web/e2e/market.e2e.ts`

**Interfaces:**
- Produces:

```ts
export function skillPackageUrl(apiBaseUrl: string, detail: Pick<SkillMarket.Detail, "source" | "id">): string
export function skillDetailUrl(pageOrigin: string, basePath: string, detail: Pick<SkillMarket.Detail, "source" | "id">): string
```

- Web `SkillMarketActions` consumes a generated prompt string:

```ts
{
  kind: "web"
  prompt: (detail: SkillMarket.Detail) => string
  copyPrompt: (prompt: string) => Promise<void>
  download: (detail: SkillMarket.Detail) => Promise<void>
}
```

- [ ] **Step 1: Write failing App prompt tests**

Update `installPrompt` tests to pass explicit links and assert the complete value:

```ts
expect(
  installPrompt(detail, {
    detailUrl: "http://10.246.13.226:4211/skills/skillhub/code-review",
    downloadUrl:
      "http://10.246.13.226:4211/v1/catalog/skills/skillhub/code-review/package",
  }),
).toBe(`请安装并使用这个 Skill：Code Review
内网详情：http://10.246.13.226:4211/skills/skillhub/code-review
内网下载：http://10.246.13.226:4211/v1/catalog/skills/skillhub/code-review/package
版本：1.2.0
SHA-256：${detail.package.sha256}
要求：仅使用上述内网地址下载，并在安装前校验 SHA-256。`)
```

Also make the rejected-copy fallback assert that the textarea contains the same `actions.prompt(detail)` string.

Run from `packages/app`:

```sh
bun run test:unit -- src/skill-market/detail.test.tsx
```

Expected: FAIL until the prompt/action contract is restored.

- [ ] **Step 2: Implement one prompt value for automatic and manual copy**

Update `SkillMarketActions`, create one memoized prompt in `WebDetailActions`, pass that value to `copyPrompt`, and use it in the manual textarea:

```ts
const prompt = createMemo(() => (props.actions.kind === "web" ? props.actions.prompt(props.detail) : ""))
```

Implement:

```ts
export function installPrompt(
  detail: SkillMarket.Detail,
  links: { readonly detailUrl: string; readonly downloadUrl: string },
) {
  return `请安装并使用这个 Skill：${detail.name}
内网详情：${links.detailUrl}
内网下载：${links.downloadUrl}
版本：${detail.version}
SHA-256：${detail.package.sha256}
要求：仅使用上述内网地址下载，并在安装前校验 SHA-256。`
}
```

Update all App test fixtures constructing Web actions to provide `prompt`. Preserve unrelated working-tree changes in the same files.

- [ ] **Step 3: Write failing URL helper tests**

In `runtime-config.test.ts` add:

```ts
expect(
  skillPackageUrl("http://10.246.13.226:4211", {
    source: "skillhub",
    id: "PPT 优化/助手",
  }),
).toBe(
  "http://10.246.13.226:4211/v1/catalog/skills/skillhub/PPT%20%E4%BC%98%E5%8C%96%2F%E5%8A%A9%E6%89%8B/package",
)
expect(
  skillPackageUrl("http://10.246.13.226:4210", {
    source: "community",
    id: "safe-community-skill",
  }),
).toBe(
  "http://10.246.13.226:4210/v1/catalog/skills/community/safe-community-skill/package",
)
```

Also assert `skillDetailUrl` respects `import.meta.env.BASE_URL`-style base paths.

Run from `packages/skill-market-web`:

```sh
bun test src/runtime-config.test.ts
```

Expected: FAIL because `skillPackageUrl` is absent.

- [ ] **Step 4: Implement URL helpers and use them in Web actions**

In `runtime-config.ts`:

```ts
import type { SkillMarket } from "@opencode-ai/schema/skill-market"

type SkillIdentity = Pick<SkillMarket.Detail, "source" | "id">

export function skillPackageUrl(apiBaseUrl: string, detail: SkillIdentity) {
  return new URL(
    `/v1/catalog/skills/${detail.source}/${encodeURIComponent(detail.id)}/package`,
    apiBaseUrl,
  ).href
}

export function skillDetailUrl(pageOrigin: string, basePath: string, detail: SkillIdentity) {
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`
  return new URL(
    `${base}skills/${detail.source}/${encodeURIComponent(detail.id)}`.replace(/^\\/\\//, "/"),
    pageOrigin,
  ).href
}
```

In `app.tsx`, configure actions:

```ts
prompt: (detail) =>
  installPrompt(detail, {
    detailUrl: skillDetailUrl(window.location.origin, import.meta.env.BASE_URL, detail),
    downloadUrl: skillPackageUrl(runtime.apiBaseUrl, detail),
  }),
copyPrompt: async (value) => {
  if (await copyText(value)) return
  throw new Error("Skill market install prompt could not be copied")
},
download: async (detail) => {
  window.location.assign(skillPackageUrl(runtime.apiBaseUrl, detail))
},
```

There must be no `source.download(...)` call in the Web download action and no `detail.package.url` in the prompt action.

- [ ] **Step 5: Update the browser fixture and E2E assertion**

Before `/download` and `/versions` handling, make `catalogRecord` recognize `/package` and return:

```ts
return new Response("verified zip fixture", {
  headers: {
    "access-control-allow-origin": webOrigin,
    "content-disposition": 'attachment; filename="skillhub-code-review-1.2.0.zip"',
    "content-type": "application/zip",
    "x-content-sha256": detail.package.sha256,
  },
})
```

Change the E2E test to:

```ts
const prompt = await page.evaluate(() => navigator.clipboard.readText())
expect(prompt).toContain("/v1/catalog/skills/skillhub/code-review/package")
expect(prompt).not.toContain("downloads.example.com")
expect(prompt).not.toContain("curl -k")

const request = page.waitForRequest(
  /\\/v1\\/catalog\\/skills\\/skillhub\\/code-review\\/package$/,
)
await page.getByRole("button", { name: "下载 ZIP" }).click()
expect((await request).url()).not.toContain("downloads.example.com")
```

Remove the obsolete route interception for `https://downloads.example.com/**`.

- [ ] **Step 6: Run App and Web verification**

From `packages/app`:

```sh
bun run test:unit -- src/skill-market/detail.test.tsx src/skill-market/provider.test.tsx src/skill-market/list.test.tsx
bun typecheck
```

From `packages/skill-market-web`:

```sh
bun run test:unit
bun run test:browser
bun run test:e2e -- --project=desktop-light --grep "copies a prompt"
bun typecheck
```

Expected: all selected tests and both typechecks pass; E2E observes only `/package`.

- [ ] **Step 7: Commit Web convergence**

```sh
git add packages/app/src/skill-market/types.ts \
  packages/app/src/skill-market/detail.tsx \
  packages/app/src/skill-market/detail.test.tsx \
  packages/skill-market-web/src/runtime-config.ts \
  packages/skill-market-web/src/runtime-config.test.ts \
  packages/skill-market-web/src/app.tsx \
  packages/skill-market-web/e2e/fixtures/server.ts \
  packages/skill-market-web/e2e/market.e2e.ts
git diff --cached --check
git commit -m "fix(skill-market): use verified package links"
```

---

### Task 5: Cross-package verification and production acceptance

**Files:**
- Modify only if verification exposes a defect: files owned by Tasks 1–4
- No migration or database file should change

**Interfaces:**
- Consumes: deployed Web and API release
- Produces: evidence that `ppt-optimizer` downloads without TLS bypass and matches the published digest

- [ ] **Step 1: Verify the complete local change set**

Run from each package directory:

```sh
cd packages/protocol && bun test test/skill-market-catalog.test.ts && bun typecheck
cd ../client && bun run check:generated && bun test && bun typecheck
cd ../skill-market-server && bun test && bun typecheck
cd ../app && bun run test:unit -- src/skill-market/detail.test.tsx src/skill-market/provider.test.tsx src/skill-market/list.test.tsx && bun typecheck
cd ../skill-market-web && bun run test && bun run test:e2e && bun typecheck && bun run build
```

Expected: every command exits 0. `git diff --exit-code -- packages/client/src/generated packages/client/src/generated-effect` is clean after `check:generated`.

- [ ] **Step 2: Review security invariants in the final diff**

Run from the repository root:

```sh
rg -n "detail\\.package\\.url|downloads\\.example\\.com|curl .*-[A-Za-z]*k" \
  packages/skill-market-web/src packages/skill-market-web/e2e
rg -n "fetch\\(|new URL\\(" packages/skill-market-server/src/package-reader.ts
git diff origin/dev...HEAD --check
```

Expected:

- no production Web prompt/download use of `detail.package.url`;
- `package-reader.ts` contains no `fetch` and no URL derived from catalog data;
- diff check reports no whitespace errors.

- [ ] **Step 3: Build and deploy in safe order**

Build the normal Skill Market Server and Web release artifacts using the repository deployment procedure. Deploy API first and verify `/health`, then deploy Web. Do not change the SkillHub sync schedule or database.

Expected: API package route is live before the Web begins linking to it.

- [ ] **Step 4: Verify the real package without `-k`**

Run:

```sh
curl -fL -D /tmp/ppt-optimizer.headers \
  -o /tmp/ppt-optimizer.zip \
  http://10.246.13.226:4211/v1/catalog/skills/skillhub/ppt-optimizer/package
shasum -a 256 /tmp/ppt-optimizer.zip
curl -fI http://10.246.13.226:4211/v1/catalog/skills/skillhub/ppt-optimizer/package
```

Expected digest:

```text
8ff40cbea13c9269ca5ad7eefab3090f27e15f5be25c5c4c2138ffbf25a71976
```

Expected headers include `application/zip`, immutable cache control, matching ETag, `X-Content-SHA256`, content length, and attachment disposition. Neither curl command uses `-k`.

- [ ] **Step 5: Verify Web behavior and rollback readiness**

Open the production `ppt-optimizer` detail page:

- copied prompt contains the market `/package` URL and the expected SHA;
- copied prompt contains no OSS host and no `-k`;
- “下载 ZIP” downloads through the same `/package` URL;
- catalog browsing and SkillHub sync status remain healthy.

If package delivery fails, roll back Web first and Server second. Existing `/download` metadata and OSS objects remain available as the compatibility path.

- [ ] **Step 6: Commit only verification fixes, if any**

If verification required code changes, repeat the affected task’s focused and package tests, then stage only those files:

```sh
git diff --check
git status --short
git commit -m "fix(skill-market): harden package delivery"
```

If no files changed, do not create an empty commit.
