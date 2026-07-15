# Ruying Skill Market Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建统一的 SkillHub + 企业精选目录、版本化 OSS 快照和供 Web/Desktop 使用的远程只读 API。

**Architecture:** 公共 DTO 放在 Schema，远程 HTTP 合约放在 Protocol；新的 `skill-market-server` 包以 SkillHub 适配器和企业索引适配器生成统一快照，经 S3 兼容接口写入 OSS，再由只读 API 从当前快照提供分页、筛选、详情和下载。同步失败只记录失败状态，不移动 `current.json`，因此线上始终保留最近一次完整快照。

**Tech Stack:** Bun 1.3.14、TypeScript、Effect Schema/HttpApi、`@aws-sdk/client-s3`、Bun test。

## Global Constraints

- 只在 `ruying-code-oem` 分支实现，不改变上游 `dev` 的默认体验。
- 运行时依赖保持 Schema → Protocol → Server；App 不依赖 Core 或 Server。
- 不直接修改 `packages/client/src/generated` 或 `packages/client/src/generated-effect`。
- 所有远程目录、详情、图标和包 URL 必须是 HTTPS，并受允许域名列表限制。
- SkillHub 每 10 分钟同步；企业索引每 2 分钟按 ETag 检查。
- 目录发布采用不可变 revision，验证完成后最后更新 `current.json`。
- 缓存命中时，20,000 条目录列表 API P95 小于 300 ms；基准数据同时覆盖 80,000 条。
- 不记录 Skill 正文、用户项目路径、剪贴板内容或 API Key。
- 测试和 `bun typecheck` 必须从对应 package 目录运行。

---

## File Structure

- `packages/schema/src/skill-market.ts`：统一目录、详情、版本、安全报告、企业索引和查询 DTO。
- `packages/protocol/src/groups/skill-market-catalog.ts`：远程只读 API 合约。
- `packages/protocol/src/skill-market-api.ts`：独立远程 API 聚合对象。
- `packages/skill-market-server/src/config.ts`：环境配置和 HTTPS/域名白名单。
- `packages/skill-market-server/src/skillhub.ts`：唯一理解 SkillHub 原始字段的适配器。
- `packages/skill-market-server/src/enterprise.ts`：企业索引解析和覆盖规则。
- `packages/skill-market-server/src/catalog.ts`：合并、搜索、排序、分页和详情读取。
- `packages/skill-market-server/src/oss.ts`：版本化对象写入、完整性验证和指针切换。
- `packages/skill-market-server/src/handlers.ts`：Effect HttpApi 只读处理器。
- `packages/skill-market-server/src/server.ts`：HTTP 进程入口。
- `packages/skill-market-server/src/sync.ts`：一次性同步入口，供定时任务调用。
- `packages/skill-market-server/fixtures/`：固定 SkillHub、企业索引和安全报告样本。
- `packages/skill-market-server/test/`：适配器、合并、OSS、HTTP 和性能测试。

### Task 1: Define shared market schemas

**Files:**
- Create: `packages/schema/src/skill-market.ts`
- Modify: `packages/schema/src/index.ts`
- Create: `packages/schema/test/skill-market.test.ts`

**Interfaces:**
- Consumes: `effect/Schema` and the repository's exported `optional` helper.
- Produces: `SkillMarket.Source`, `Risk`, `Sort`, `Summary`, `Detail`, `Version`, `SecurityReport`, `Package`, `Download`, `PageQuery`, `SourceStatus`, `Page`, `Facets`, `EnterpriseIndex`, `InstallRequest`, `Installed`, and `OperationResult` schemas and TypeScript types.

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SkillMarket } from "../src/skill-market"

describe("SkillMarket", () => {
  test("decodes a catalog page and rejects an insecure package URL", () => {
    const summary = {
      id: "code-review",
      source: "skillhub",
      sourceUrl: "https://skillhub.cn/skills/code-review",
      name: "Code Review",
      description: "Review code",
      categories: ["Development"],
      tags: [],
      requiresApiKey: false,
      risk: "safe",
      version: "1.0.0",
      updatedAt: "2026-07-15T00:00:00.000Z",
      downloads: 20,
      favorites: 3,
      score: 9.5,
      featured: false,
      enterprise: false,
      delisted: false,
    }
    expect(Schema.decodeUnknownSync(SkillMarket.Page)({ revision: "r1", sourceStatus: { skillhub: "fresh", enterprise: "fresh" }, total: 1, page: 1, limit: 30, items: [summary] }).items).toHaveLength(1)
    expect(() => Schema.decodeUnknownSync(SkillMarket.Package)({ url: "http://example.com/a.zip", sha256: "a".repeat(64), size: 1, files: [] })).toThrow()
  })

  test("requires risk confirmation in install payload shape", () => {
    const value = Schema.decodeUnknownSync(SkillMarket.InstallRequest)({
      source: "enterprise",
      id: "safe-id",
      version: "1.0.0",
      sha256: "b".repeat(64),
      riskConfirmed: true,
    })
    expect(value.riskConfirmed).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `cd packages/schema && bun test test/skill-market.test.ts`

Expected: FAIL with `Cannot find module '../src/skill-market'`.

- [ ] **Step 3: Add the complete public schema vocabulary**

Create schemas with these exact fields and literals:

```ts
export * as SkillMarket from "./skill-market"

import { Schema } from "effect"
import { optional } from "./schema"

export const Source = Schema.Literals(["skillhub", "enterprise"])
export type Source = typeof Source.Type
export const Risk = Schema.Literals(["unknown", "safe", "warning", "danger"])
export type Risk = typeof Risk.Type
export const Sort = Schema.Literals(["score", "featured", "trending", "downloads", "recent"])
export type Sort = typeof Sort.Type
export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/))
export const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/))
const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const PageNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100_000))
const PageLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))

export const SecurityReport = Schema.Struct({
  provider: Schema.String,
  verdict: Risk,
  summary: Schema.String,
  reportUrl: HttpsUrl.pipe(optional),
})
export type SecurityReport = typeof SecurityReport.Type

export const Version = Schema.Struct({
  version: Schema.String,
  publishedAt: Timestamp,
  sha256: Sha256,
  size: NonNegative,
})
export type Version = typeof Version.Type

export const Package = Schema.Struct({
  url: HttpsUrl,
  sha256: Sha256,
  size: NonNegative,
  files: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Sha256, size: NonNegative })),
})
export type Package = typeof Package.Type
export const Download = Schema.Struct({ url: HttpsUrl, sha256: Sha256, size: NonNegative })
export type Download = typeof Download.Type

export const Summary = Schema.Struct({
  id: Schema.String,
  source: Source,
  sourceUrl: HttpsUrl,
  name: Schema.String,
  description: Schema.String,
  iconUrl: HttpsUrl.pipe(optional),
  categories: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
  requiresApiKey: Schema.Boolean,
  risk: Risk,
  version: Schema.String,
  updatedAt: Timestamp,
  downloads: NonNegative,
  favorites: NonNegative,
  score: Schema.Number,
  featured: Schema.Boolean,
  enterprise: Schema.Boolean,
  delisted: Schema.Boolean,
  installedVersion: Schema.String.pipe(optional),
  updateAvailable: Schema.Boolean.pipe(optional),
})
export type Summary = typeof Summary.Type

export const Detail = Schema.Struct({
  ...Summary.fields,
  readme: Schema.String,
  license: Schema.String.pipe(optional),
  author: Schema.Struct({ name: Schema.String, url: HttpsUrl.pipe(optional) }),
  versions: Schema.Array(Version),
  securityReports: Schema.Array(SecurityReport),
  riskReason: Schema.String.pipe(optional),
  package: Package,
  publicDetailUrl: HttpsUrl,
})
export type Detail = typeof Detail.Type

export const PageQuery = Schema.Struct({
  query: Schema.String.pipe(optional),
  source: Source.pipe(optional),
  category: Schema.String.pipe(optional),
  requiresApiKey: Schema.Boolean.pipe(optional),
  featured: Schema.Boolean.pipe(optional),
  enterprise: Schema.Boolean.pipe(optional),
  sort: Sort,
  page: PageNumber,
  limit: PageLimit,
})
export type PageQuery = typeof PageQuery.Type

export const SourceStatus = Schema.Struct({ skillhub: Schema.Literals(["fresh", "stale", "unavailable"]), enterprise: Schema.Literals(["fresh", "stale", "unavailable"]) })
export type SourceStatus = typeof SourceStatus.Type
export const Page = Schema.Struct({ revision: Schema.String, sourceStatus: SourceStatus, total: NonNegative, page: Schema.Int, limit: Schema.Int, items: Schema.Array(Summary) })
export type Page = typeof Page.Type
export const Facets = Schema.Struct({ revision: Schema.String, sourceStatus: SourceStatus, sources: Schema.Array(Schema.Struct({ value: Source, count: NonNegative })), categories: Schema.Array(Schema.Struct({ value: Schema.String, count: NonNegative })), requiresApiKey: Schema.Struct({ yes: NonNegative, no: NonNegative }) })
export type Facets = typeof Facets.Type

export const EnterpriseIndex = Schema.Struct({ schemaVersion: Schema.Literal(1), updatedAt: Timestamp, skills: Schema.Array(Schema.Struct({ id: Schema.String, source: Source, referenceId: Schema.String.pipe(optional), featured: Schema.Boolean, delisted: Schema.Boolean.pipe(optional), name: Schema.String, description: Schema.String, category: Schema.String, version: Schema.String, risk: Risk.pipe(optional), riskReason: Schema.String.pipe(optional), license: Schema.String.pipe(optional), package: Schema.Struct({ url: HttpsUrl, sha256: Sha256 }).pipe(optional) })) })
export type EnterpriseIndex = typeof EnterpriseIndex.Type

export const InstallRequest = Schema.Struct({ source: Source, id: Schema.String, version: Schema.String, sha256: Sha256, riskConfirmed: Schema.Boolean.pipe(optional) })
export type InstallRequest = typeof InstallRequest.Type
export const Installed = Schema.Struct({ source: Source, id: Schema.String, name: Schema.String, version: Schema.String, installedAt: Timestamp, updateAvailable: Schema.Boolean, loadState: Schema.Literals(["ready", "refresh-failed"]) })
export type Installed = typeof Installed.Type
export const OperationResult = Schema.Struct({ installed: Installed, changed: Schema.Boolean })
export type OperationResult = typeof OperationResult.Type
```

Add `export { SkillMarket } from "./skill-market"` to `packages/schema/src/index.ts`.

- [ ] **Step 4: Run schema tests and typecheck**

Run: `cd packages/schema && bun test test/skill-market.test.ts && bun typecheck`

Expected: both commands exit 0.

- [ ] **Step 5: Commit shared schemas**

```bash
git add packages/schema/src/skill-market.ts packages/schema/src/index.ts packages/schema/test/skill-market.test.ts
git commit -m "feat(schema): add skill market contracts"
```

### Task 2: Define the remote read-only HttpApi

**Files:**
- Create: `packages/protocol/src/groups/skill-market-catalog.ts`
- Create: `packages/protocol/src/skill-market-api.ts`
- Create: `packages/protocol/test/skill-market-catalog.test.ts`

**Interfaces:**
- Consumes: all schemas exported by `@opencode-ai/schema/skill-market`.
- Produces: `SkillMarketCatalogGroup` with endpoint identifiers `skillMarket.catalog.list`, `facets`, `detail`, `versions`, and `download`; `SkillMarketCatalogApi` aggregates only that group and has no local Location middleware.

- [ ] **Step 1: Write a failing contract test**

```ts
import { expect, test } from "bun:test"
import { HttpApi } from "effect/unstable/httpapi"
import { normalizeSkillMarketCatalogQuery } from "../src/groups/skill-market-catalog"
import { SkillMarketCatalogApi } from "../src/skill-market-api"

test("catalog api contains five public operations", () => {
  const endpoints: string[] = []
  HttpApi.reflect(SkillMarketCatalogApi, {
    onGroup() {},
    onEndpoint({ endpoint }) { endpoints.push(endpoint.name) },
  })
  expect(endpoints.toSorted()).toEqual(["skillMarket.catalog.detail", "skillMarket.catalog.download", "skillMarket.catalog.facets", "skillMarket.catalog.list", "skillMarket.catalog.versions"])
})

test("normalizes portable query strings into domain values", () => {
  expect(normalizeSkillMarketCatalogQuery({ requiresApiKey: "false", featured: "true", page: 2 })).toEqual({
    query: undefined,
    source: undefined,
    category: undefined,
    requiresApiKey: false,
    featured: true,
    enterprise: undefined,
    sort: "score",
    page: 2,
    limit: 30,
  })
})
```

- [ ] **Step 2: Verify the contract test fails**

Run: `cd packages/protocol && bun test test/skill-market-catalog.test.ts`

Expected: FAIL because `skill-market-api.ts` does not exist.

- [ ] **Step 3: Implement the exact remote endpoints**

```ts
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const Key = { source: SkillMarket.Source, id: Schema.String }
export const SkillMarketCatalogQuery = Schema.Struct({
  query: Schema.String.pipe(Schema.optional),
  source: SkillMarket.Source.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  requiresApiKey: Schema.Literals(["true", "false"]).pipe(Schema.optional),
  featured: Schema.Literals(["true", "false"]).pipe(Schema.optional),
  enterprise: Schema.Literals(["true", "false"]).pipe(Schema.optional),
  sort: SkillMarket.Sort.pipe(Schema.optional),
  page: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100_000)).pipe(Schema.optional),
  limit: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)).pipe(Schema.optional),
})

export function normalizeSkillMarketCatalogQuery(query: typeof SkillMarketCatalogQuery.Type): SkillMarket.PageQuery {
  return {
    query: query.query,
    source: query.source,
    category: query.category,
    requiresApiKey: query.requiresApiKey === undefined ? undefined : query.requiresApiKey === "true",
    featured: query.featured === undefined ? undefined : query.featured === "true",
    enterprise: query.enterprise === undefined ? undefined : query.enterprise === "true",
    sort: query.sort ?? "score",
    page: query.page ?? 1,
    limit: query.limit ?? 30,
  }
}

export class SkillMarketNotFound extends Schema.ErrorClass<SkillMarketNotFound>("SkillMarketNotFound")(
  { source: SkillMarket.Source, id: Schema.String },
  { httpApiStatus: 404 },
) {}

export const SkillMarketCatalogGroup = HttpApiGroup.make("skillMarket.catalog")
  .add(HttpApiEndpoint.get("skillMarket.catalog.list", "/v1/catalog/skills", { query: SkillMarketCatalogQuery, success: SkillMarket.Page }))
  .add(HttpApiEndpoint.get("skillMarket.catalog.facets", "/v1/catalog/facets", { success: SkillMarket.Facets }))
  .add(HttpApiEndpoint.get("skillMarket.catalog.detail", "/v1/catalog/skills/:source/:id", { params: Key, success: SkillMarket.Detail, error: SkillMarketNotFound }))
  .add(HttpApiEndpoint.get("skillMarket.catalog.versions", "/v1/catalog/skills/:source/:id/versions", { params: Key, success: Schema.Array(SkillMarket.Version), error: SkillMarketNotFound }))
  .add(HttpApiEndpoint.get("skillMarket.catalog.download", "/v1/catalog/skills/:source/:id/download", { params: Key, success: SkillMarket.Download, error: SkillMarketNotFound }))
  .annotateMerge(OpenApi.annotations({ title: "Ruying Skill Market Catalog", description: "Read-only public catalog API." }))
```

```ts
import { HttpApi } from "effect/unstable/httpapi"
import { SkillMarketCatalogGroup } from "./groups/skill-market-catalog"

export const SkillMarketCatalogApi = HttpApi.make("skillMarketCatalog").add(SkillMarketCatalogGroup)
```

- [ ] **Step 4: Run protocol verification**

Run: `cd packages/protocol && bun test test/skill-market-catalog.test.ts && bun typecheck`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit the remote contract**

```bash
git add packages/protocol/src/groups/skill-market-catalog.ts packages/protocol/src/skill-market-api.ts packages/protocol/test/skill-market-catalog.test.ts
git commit -m "feat(protocol): add skill market catalog api"
```

### Task 3: Build source adapters and deterministic catalog merge

**Files:**
- Create: `packages/skill-market-server/package.json`
- Create: `packages/skill-market-server/tsconfig.json`
- Create: `packages/skill-market-server/src/config.ts`
- Create: `packages/skill-market-server/src/skillhub.ts`
- Create: `packages/skill-market-server/src/enterprise.ts`
- Create: `packages/skill-market-server/src/catalog.ts`
- Create: `packages/skill-market-server/fixtures/skillhub-page.json`
- Create: `packages/skill-market-server/fixtures/skillhub-detail.json`
- Create: `packages/skill-market-server/fixtures/enterprise-index.json`
- Create: `packages/skill-market-server/test/sources.test.ts`
- Create: `packages/skill-market-server/test/catalog.test.ts`

**Interfaces:**
- Consumes: SkillHub endpoints `/api/skills`, `/api/v1/skills/:slug`, `/files`, `/versions`; `SkillMarket.EnterpriseIndex` from Task 1.
- Produces: `loadSkillHub(fetcher, baseUrl, previous?): Promise<SkillMarket.Detail[]>`, `loadEnterprise(fetcher, url, allowedHosts): Promise<SkillMarket.EnterpriseIndex>`, `mergeCatalog(skillhub, enterprise): CatalogSnapshot`, and `queryCatalog(snapshot, query): SkillMarket.Page`; `previous` is `ReadonlyMap<string, SkillMarket.Detail> | undefined` and `allowedHosts` is `ReadonlySet<string>`.

- [ ] **Step 1: Add source and merge tests using fixed fixtures**

Create the package shell before the tests:

```json
{
  "$schema": "https://json.schemastore.org/package.json",
  "name": "@opencode-ai/skill-market-server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/server.ts",
    "start": "bun src/server.ts",
    "sync": "bun src/sync.ts",
    "test": "bun test",
    "typecheck": "tsgo --noEmit"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "3.933.0",
    "@effect/platform-node": "catalog:",
    "@opencode-ai/protocol": "workspace:*",
    "@opencode-ai/schema": "workspace:*",
    "effect": "catalog:"
  },
  "devDependencies": {
    "@tsconfig/node22": "catalog:",
    "@types/bun": "catalog:",
    "@types/node": "catalog:",
    "@typescript/native-preview": "catalog:",
    "typescript": "catalog:"
  }
}
```

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@tsconfig/node22/tsconfig.json",
  "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler", "strict": true, "noEmit": true },
  "include": ["src", "test", "package.json"]
}
```

```ts
import { describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { loadEnterprise } from "../src/enterprise"
import { mergeCatalog, queryCatalog } from "../src/catalog"
import { loadSkillHub } from "../src/skillhub"

describe("catalog sources", () => {
  test("normalizes SkillHub and lets enterprise metadata override display fields without reducing risk", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input)
      const file = url.includes("enterprise") ? "enterprise-index.json" : url.includes("/api/skills?") ? "skillhub-page.json" : "skillhub-detail.json"
      return new Response(Bun.file(new URL(`../fixtures/${file}`, import.meta.url)), { headers: { "content-type": "application/json" } })
    }
    const skillhub = await loadSkillHub(fetcher, "https://api.skillhub.cn")
    const enterprise = await loadEnterprise(fetcher, "https://oss.example.com/enterprise.json", new Set(["oss.example.com"]))
    const snapshot = mergeCatalog(skillhub, enterprise)
    expect(snapshot.items.find((item) => item.id === "code-review")?.featured).toBe(true)
    expect(snapshot.details.get("skillhub:code-review")?.risk).toBe("warning")
  })

  test("filters and paginates before returning list DTOs", () => {
    const enterprise = Schema.decodeUnknownSync(SkillMarket.EnterpriseIndex)({
      schemaVersion: 1,
      updatedAt: "2026-07-15T00:00:00.000Z",
      skills: [{
        id: "enterprise-review",
        source: "enterprise",
        featured: true,
        name: "企业 Review",
        description: "企业代码评审",
        category: "企业效率",
        version: "1.0.0",
        package: { url: "https://oss.example.com/enterprise-review.zip", sha256: "a".repeat(64) },
      }],
    })
    const snapshot = mergeCatalog([], enterprise)
    const page = queryCatalog(snapshot, { query: "企业", sort: "score", page: 1, limit: 30 })
    expect(page.items.every((item) => !Object.hasOwn(item, "readme"))).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests and verify missing implementation failures**

Run: `cd packages/skill-market-server && bun test test/sources.test.ts test/catalog.test.ts`

Expected: FAIL for missing `src/skillhub.ts`, `src/enterprise.ts`, and `src/catalog.ts`.

- [ ] **Step 3: Implement configuration and adapters**

`config.ts` must decode these environment values and expose one immutable object:

```ts
function requireHttps(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${name} must be an HTTPS URL without credentials`)
  return url.href
}

export const config = {
  port: Number(process.env.SKILL_MARKET_PORT ?? "4210"),
  skillhubBaseUrl: process.env.SKILLHUB_BASE_URL ?? "https://api.skillhub.cn",
  enterpriseIndexUrl: requireHttps("SKILL_MARKET_ENTERPRISE_INDEX_URL"),
  ossEndpoint: requireHttps("SKILL_MARKET_OSS_ENDPOINT"),
  ossRegion: process.env.SKILL_MARKET_OSS_REGION ?? "cn-baoding",
  ossBucket: process.env.SKILL_MARKET_OSS_BUCKET ?? "app-platform",
  ossPrefix: process.env.SKILL_MARKET_OSS_PREFIX ?? "ai-coding/ruying-code/skill-market",
  publicBaseUrl: requireHttps("SKILL_MARKET_PUBLIC_BASE_URL"),
  allowedHosts: new Set((process.env.SKILL_MARKET_ALLOWED_HOSTS ?? "api.skillhub.cn").split(",").map((value) => value.trim()).filter(Boolean)),
}
```

`skillhub.ts` must page through `GET /api/skills?page=N&pageSize=100&sortBy=score`, fetch changed detail/files/versions with concurrency 8, reuse `previous` details when version and `updated_at` are unchanged, preserve `sourceUrl` and license text, and map external risk with `safe < unknown < warning < danger`. Before publication, the verified package's root `SKILL.md` frontmatter name becomes the stable `id`; a slug/name mismatch is recorded as an alias but the installable ID is always the frontmatter name. `enterprise.ts` must decode with `Schema.decodeUnknownPromise(SkillMarket.EnterpriseIndex)` and reject package hosts outside `allowedHosts`.

- [ ] **Step 4: Implement deterministic merge, facets, search and pagination**

```ts
export type CatalogSnapshot = {
  revision: string
  createdAt: string
  items: SkillMarket.Summary[]
  details: Map<string, SkillMarket.Detail>
  facets: SkillMarket.Facets
  sourceStatus: SkillMarket.SourceStatus
}

export function key(source: SkillMarket.Source, id: string) {
  return `${source}:${id}`
}

export function queryCatalog(snapshot: CatalogSnapshot, query: SkillMarket.PageQuery): SkillMarket.Page {
  const keyword = query.query?.trim().toLocaleLowerCase()
  const filtered = snapshot.items
    .filter((item) => !query.source || item.source === query.source)
    .filter((item) => !query.category || item.categories.includes(query.category))
    .filter((item) => query.requiresApiKey === undefined || item.requiresApiKey === query.requiresApiKey)
    .filter((item) => query.featured === undefined || item.featured === query.featured)
    .filter((item) => query.enterprise === undefined || item.enterprise === query.enterprise)
    .filter((item) => !keyword || `${item.name}\n${item.description}\n${item.tags.join(" ")}`.toLocaleLowerCase().includes(keyword))
  const items = filtered.toSorted(comparator(query.sort))
  const start = (query.page - 1) * query.limit
  return { revision: snapshot.revision, sourceStatus: snapshot.sourceStatus, total: items.length, page: query.page, limit: query.limit, items: items.slice(start, start + query.limit) }
}

function comparator(sort: SkillMarket.Sort) {
  const number = (left: number, right: number) => right - left
  return (left: SkillMarket.Summary, right: SkillMarket.Summary) => {
    if (sort === "downloads") return number(left.downloads, right.downloads) || number(left.score, right.score)
    if (sort === "recent") return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    if (sort === "featured") return Number(right.featured) - Number(left.featured) || number(left.score, right.score)
    if (sort === "trending") return number(left.score, right.score) || number(left.downloads, right.downloads)
    return number(left.score, right.score) || left.name.localeCompare(right.name)
  }
}
```

`mergeCatalog` must apply enterprise references after SkillHub normalization, set `enterprise: true`, allow display/category/featured/delisted/license overrides, and choose the stricter risk by rank; an enterprise override can never reduce the SkillHub risk. Generate `revision` from a SHA-256 of canonical sorted summaries so identical inputs produce identical revisions.

- [ ] **Step 5: Run adapter and catalog tests**

Run: `cd packages/skill-market-server && bun test test/sources.test.ts test/catalog.test.ts && bun typecheck`

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 6: Commit source aggregation**

```bash
git add packages/skill-market-server/package.json packages/skill-market-server/tsconfig.json packages/skill-market-server/src/config.ts packages/skill-market-server/src/skillhub.ts packages/skill-market-server/src/enterprise.ts packages/skill-market-server/src/catalog.ts packages/skill-market-server/fixtures packages/skill-market-server/test/sources.test.ts packages/skill-market-server/test/catalog.test.ts
git commit -m "feat(skill-market): aggregate catalog sources"
```

### Task 4: Publish immutable OSS snapshots atomically

**Files:**
- Create: `packages/skill-market-server/src/oss.ts`
- Create: `packages/skill-market-server/test/oss.test.ts`

**Interfaces:**
- Consumes: `CatalogSnapshot`, S3-compatible `PutObject`, `GetObject`, and `HeadObject` operations.
- Produces: `publishSnapshot(client, config, snapshot): Promise<{ revision: string; pointerKey: string }>` and `loadCurrentSnapshot(client, config): Promise<CatalogSnapshot>`.

- [ ] **Step 1: Write a failing atomic publication test**

```ts
test("updates current.json only after every immutable object validates", async () => {
  const store = memoryObjectStore()
  await publishSnapshot(store.client, testConfig, sampleSnapshot("r1"))
  expect(store.writes.at(-1)?.key).toBe("skill-market/current.json")
  store.failOn = /details/
  await expect(publishSnapshot(store.client, testConfig, sampleSnapshot("r2"))).rejects.toThrow()
  expect(JSON.parse(store.objects.get("skill-market/current.json")!).revision).toBe("r1")
})
```

The in-memory client records real request bodies and throws on the configured key; it does not duplicate publication decisions.

- [ ] **Step 2: Run the OSS test and verify failure**

Run: `cd packages/skill-market-server && bun test test/oss.test.ts`

Expected: FAIL because `publishSnapshot` is missing.

- [ ] **Step 3: Implement the exact object layout and pointer-last rule**

```ts
const keys = (prefix: string, revision: string) => ({
  current: `${prefix}/current.json`,
  catalog: `${prefix}/indexes/${revision}/catalog.json`,
  facets: `${prefix}/indexes/${revision}/facets.json`,
  detail: (source: string, id: string) => `${prefix}/indexes/${revision}/details/${source}/${encodeURIComponent(id)}.json`,
})

export type ObjectStore = {
  put: (key: string, body: string | Uint8Array, contentType: string, cacheControl: string) => Promise<void>
  get: (key: string) => Promise<Uint8Array>
  head: (key: string) => Promise<{ size: number }>
}
export type PublishConfig = { prefix: string }

export async function publishSnapshot(client: ObjectStore, config: PublishConfig, snapshot: CatalogSnapshot) {
  const objectKeys = keys(config.prefix, snapshot.revision)
  await Promise.all([
    client.put(objectKeys.catalog, JSON.stringify({ revision: snapshot.revision, createdAt: snapshot.createdAt, items: snapshot.items }), "application/json", "public, max-age=31536000, immutable"),
    client.put(objectKeys.facets, JSON.stringify(snapshot.facets), "application/json", "public, max-age=31536000, immutable"),
    ...Array.from(snapshot.details.values(), (detail) => client.put(objectKeys.detail(detail.source, detail.id), JSON.stringify(detail), "application/json", "public, max-age=31536000, immutable")),
  ])
  await validatePublished(client, objectKeys, snapshot)
  await client.put(objectKeys.current, JSON.stringify({ revision: snapshot.revision, createdAt: snapshot.createdAt }), "application/json", "public, max-age=60")
  return { revision: snapshot.revision, pointerKey: objectKeys.current }
}
```

`validatePublished` must HEAD catalog/facets/every detail, decode JSON with the Task 1 schemas, assert item/detail counts and matching revision, then allow pointer update. The AWS adapter uses path-style S3 with the configured endpoint and bucket.

- [ ] **Step 4: Run publication and regression tests**

Run: `cd packages/skill-market-server && bun test test/oss.test.ts test/catalog.test.ts`

Expected: PASS; failed `r2` leaves pointer on `r1`.

- [ ] **Step 5: Commit OSS publication**

```bash
git add packages/skill-market-server/src/oss.ts packages/skill-market-server/test/oss.test.ts
git commit -m "feat(skill-market): publish atomic oss snapshots"
```

### Task 5: Serve catalog HTTP routes and schedule synchronization

**Files:**
- Create: `packages/skill-market-server/src/handlers.ts`
- Create: `packages/skill-market-server/src/server.ts`
- Create: `packages/skill-market-server/src/sync.ts`
- Create: `packages/skill-market-server/test/http.test.ts`
- Create: `packages/skill-market-server/test/performance.test.ts`
- Create: `packages/skill-market-server/README.md`
- Modify: `packages/skill-market-server/package.json`

**Interfaces:**
- Consumes: `SkillMarketCatalogApi`, `queryCatalog`, `loadCurrentSnapshot`, `publishSnapshot`.
- Produces: an HTTP process on `SKILL_MARKET_PORT`, a one-shot `bun run sync` command, and stable cache/source-state response headers.

- [ ] **Step 1: Write HTTP behavior and 80k performance tests**

```ts
test("serves list, detail, versions and download from one revision", async () => {
  const client = makeTestClient(sampleSnapshot("r1"))
  const page = await client.get("/v1/catalog/skills?sort=score&page=1&limit=30")
  expect(page.status).toBe(200)
  expect(page.headers.get("x-skill-market-revision")).toBe("r1")
  expect((await page.json()).items).toHaveLength(1)
  expect((await client.get("/v1/catalog/skills/skillhub/code-review")).status).toBe(200)
})

test("queries 80000 cached summaries within the 300 ms p95 budget", () => {
  const snapshot = benchmarkSnapshot(80_000)
  const samples = Array.from({ length: 100 }, () => {
    const started = performance.now()
    queryCatalog(snapshot, { query: "typescript", sort: "score", page: 1, limit: 30 })
    return performance.now() - started
  }).toSorted((a, b) => a - b)
  expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(300)
})
```

- [ ] **Step 2: Verify HTTP tests fail before handlers exist**

Run: `cd packages/skill-market-server && bun test test/http.test.ts test/performance.test.ts`

Expected: HTTP test fails for missing server layer; performance test establishes a local red/green baseline.

- [ ] **Step 3: Implement the HttpApi handlers**

`handlers.ts` must bind all five endpoint identifiers. Every request loads `current.json` once, retains that revision for the whole response, sets `x-skill-market-revision`, and returns `HttpApiSchema.NotFound` for missing or delisted details. Download returns the verified package URL/hash/size; it never accepts an arbitrary target URL from the request.

```ts
export const handlers = HttpApiBuilder.group(SkillMarketCatalogApi, "skillMarket.catalog", (handlers) =>
  handlers
    .handle("skillMarket.catalog.list", (ctx) => Catalog.Service.use((catalog) => catalog.list(normalizeSkillMarketCatalogQuery(ctx.query))))
    .handle("skillMarket.catalog.facets", () => Catalog.Service.use((catalog) => catalog.facets()))
    .handle("skillMarket.catalog.detail", (ctx) => Catalog.Service.use((catalog) => catalog.detail(ctx.params)))
    .handle("skillMarket.catalog.versions", (ctx) => Catalog.Service.use((catalog) => catalog.versions(ctx.params)))
    .handle("skillMarket.catalog.download", (ctx) => Catalog.Service.use((catalog) => catalog.download(ctx.params))),
)
```

- [ ] **Step 4: Add process and one-shot sync entrypoints**

`sync.ts` performs one SkillHub sync and one ETag-aware enterprise fetch, merges with any stale source snapshot if exactly one source fails, and rejects publication when both sources fail and no prior snapshot exists. For each package it follows redirects only within `allowedHosts`, enforces the 50 MiB compressed cap, computes SHA-256 while streaming, verifies any enterprise-provided hash, checks the SkillHub file manifest, and writes the immutable OSS package/icon before publishing catalog references; it derives package `size`, `files` and installable frontmatter ID during this step. Only then call `publishSnapshot`. `server.ts` serves the read API plus a health probe; production scheduling invokes `bun run sync` every 2 minutes and `sync.ts` skips SkillHub when its last successful sync is less than 10 minutes old.

The read server returns `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`, never enables credentials, and handles OPTIONS without touching catalog state so the standalone Web can call it cross-origin.

Add these scripts:

```json
{
  "scripts": {
    "dev": "bun --watch src/server.ts",
    "start": "bun src/server.ts",
    "sync": "bun src/sync.ts",
    "test": "bun test",
    "typecheck": "tsgo --noEmit"
  }
}
```

- [ ] **Step 5: Document production variables, probes and rollback**

The README must list every variable from Task 3, `GET /health`, the 2-minute scheduler command, metrics names `skill_market_sync_duration_ms`, `skill_market_source_success`, `skill_market_catalog_count`, `skill_market_cache_hit`, `skill_market_download_result`, and rollback instructions that overwrite only `current.json` with a retained revision after validating its catalog/facets/details.

- [ ] **Step 6: Run complete backend verification**

Run: `cd packages/skill-market-server && bun test && bun typecheck`

Expected: all adapter, merge, OSS, HTTP and 80k tests pass; typecheck exits 0.

Run: `cd packages/schema && bun typecheck && cd ../protocol && bun typecheck`

Expected: both dependency packages typecheck.

- [ ] **Step 7: Commit the runnable backend**

```bash
git add packages/skill-market-server
git commit -m "feat(skill-market): serve synchronized catalog"
```

## Plan Completion Gate

- `git diff dev...HEAD -- packages/schema packages/protocol packages/skill-market-server` contains no App, Core or Desktop runtime dependency violation.
- `rg -n "http://|console\.log|SKILL\.md" packages/skill-market-server/src` has no insecure production URL, raw Skill body logging, or accidental debug logging.
- A forced SkillHub failure publishes enterprise + stale SkillHub; a forced enterprise failure publishes SkillHub + stale enterprise; a double failure does not move `current.json`.
- The published catalog, facets and every detail decode with Task 1 schemas before the pointer is moved.
- The remote API exposes exactly the five read-only routes in the approved design and no installation mutation.
