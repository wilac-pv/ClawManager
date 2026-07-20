# SkillHub 推荐精选同步设计

日期：2026-07-20

状态：待书面复核

## 1. 背景

技能市场当前可以同步 SkillHub 全量目录，但所有 SkillHub 条目在物化时都被设置为
`featured: false`。因此公共目录有数据，而“推荐精选”筛选结果始终为空。

SkillHub 页面虽然使用 `sortBy=curated_score` 表示推荐精选，前端实际将该选项映射到
`GET /api/v1/showcase/recommended`。SkillHub 普通列表 API 不接受
`sortBy=curated_score`，会返回 HTTP 400。

企业精选索引是独立的数据源，不能替代 SkillHub 官方推荐集合。

## 2. 已确认需求

- SkillHub 推荐精选完全跟随 `/api/v1/showcase/recommended` 的全部返回结果。
- 不限制 Top 50；接口当前返回 100 条时应同步全部 100 条。
- 全量 SkillHub 目录同步逻辑保持不变。
- 推荐集合通过 `slug` 与全量 SkillHub 目录匹配。
- 匹配到的 SkillHub 条目标记为 `featured: true`，其余条目标记为 `featured: false`。
- 推荐接口失败时保留上一版已发布目录中的推荐标记。
- 推荐接口成功返回空数组时，将 SkillHub 推荐集合清空。
- 企业索引中显式配置为 `featured: true` 的条目仍可进入推荐精选。
- 不修改公共 HTTP API、Schema 或数据库结构。

## 3. 方案选择

### 3.1 采用：独立同步官方 Showcase

同步器在读取全量 SkillHub 目录之外，独立请求官方推荐 Showcase。该请求只读取推荐
slug，不重复下载详情或技能包。

优点：

- 与 SkillHub 页面使用同一推荐来源。
- 推荐数量由上游控制，不需要本地阈值。
- 每次同步只增加一次轻量请求。
- 推荐请求可以独立失败，不影响全量目录更新。

### 3.2 不采用：普通列表按 `curated_score` 排序

SkillHub 普通列表 API 当前不支持该参数并返回 HTTP 400。页面 URL 中的参数只是前端
路由状态，不能作为后端同步接口。

### 3.3 不采用：用企业精选索引代替官方推荐

企业精选是公司维护的数据源，和 SkillHub 官方推荐的来源、更新节奏及语义不同。两者
可以在统一目录中同时产生 `featured: true`，但不能互相替代。

## 4. 数据流

```text
SkillHub /api/skills ───────────────> 全量 SkillHub 记录与详情
                                                │
SkillHub /api/v1/showcase/recommended ─> 推荐 slug 集合
                                                │
                                                v
                                      按 slug 设置 featured
                                                │
企业精选索引 ─────────────────────────> 现有覆盖与企业条目合并
                                                │
                                                v
                                      发布版本化 OSS 快照
```

推荐集合与全量目录分开读取。推荐请求失败不会使全量 SkillHub 源失败，也不会阻止目录
发布。

## 5. 组件变更

### 5.1 SkillHub 适配器

在 `packages/skill-market-server/src/skillhub.ts` 增加独立推荐读取函数：

```ts
loadSkillHubRecommendations(
  fetcher: Fetcher,
  input: string,
): Promise<ReadonlySet<string>>
```

函数请求 `/api/v1/showcase/recommended`，使用 Effect Schema 验证响应，并返回响应中全部
技能的 slug 集合。响应顺序不参与本地排序，数量不做截断。

该函数沿用现有 SkillHub URL 和重定向约束，只允许 HTTPS 且不能重定向到其他主机。

### 5.2 同步器

在 `packages/skill-market-server/src/sync.ts` 中，将推荐请求作为独立的 settled 操作：

- 推荐请求成功：以返回的 slug 集合为准，重算所有 SkillHub 详情的 `featured`。
- 推荐请求失败且存在上一版详情：按 ID 和 aliases 查找上一版详情并保留其
  `featured`。
- 推荐请求失败且没有上一版详情：SkillHub 条目使用默认值 `false`。
- 推荐请求成功返回空集合：所有 SkillHub 条目设置为 `false`。

推荐匹配同时检查详情的 `id` 与 `aliases`。这样技能包清单名称与 SkillHub slug 不同的
条目仍能正确匹配。

企业索引的既有覆盖行为保持不变：显式 `featured: true` 的企业条目或 SkillHub 引用仍
可进入推荐精选。

## 6. 错误处理

- HTTP 非 2xx、跨主机重定向或 Schema 验证失败都视为推荐请求失败。
- 失败时记录结构化警告，但不输出响应正文或敏感 URL 查询参数。
- 推荐请求失败不会清空上一版推荐，也不会阻止全量目录发布。
- 成功的空集合与请求失败必须严格区分；只有前者可以清空推荐。
- 全量 SkillHub 同步失败时继续沿用现有快照回退规则，并将成功获取的新推荐集合应用于
  可用的上一版 SkillHub 详情。

## 7. 测试策略

在 `packages/skill-market-server/test/skillhub.test.ts` 或现有适配器测试中验证：

- 推荐适配器请求正确路径。
- 返回数量不截断，100 个 slug 全部保留。
- 非法响应和跨主机重定向被拒绝。

在 `packages/skill-market-server/test/sync.test.ts` 中验证：

- 推荐集合中的 slug 被标记为 `featured: true`。
- 不在集合中的旧推荐在成功同步后被清除。
- 推荐接口失败时保留上一版推荐标记。
- 推荐接口成功返回空数组时清空 SkillHub 推荐。
- aliases 可以匹配推荐 slug。
- 企业索引的 `featured: true` 行为不回归。

测试必须先失败，再实现最小代码使其通过。完成后从
`packages/skill-market-server` 运行完整测试和 `bun typecheck`。

## 8. 发布与验证

该变更不修改公共 Protocol 或 Server `HttpApi`，无需重新生成 Client。

部署后验证：

- `/v1/catalog/skills?featured=true` 返回非零结果。
- SkillHub 官方 Showcase 当前返回 100 条时，本地可匹配条目全部带有
  `featured: true`。
- `/v1/catalog/skills?enterprise=true` 仍由企业索引独立控制。
- 推荐接口临时失败时，线上推荐列表不会变为空。

由于只增加一次小型 JSON 请求，不会增加技能包下载数量，也不应显著增加同步期间的
CPU、内存或磁盘 IO。
