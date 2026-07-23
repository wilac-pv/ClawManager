import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { createQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { DesktopInstalledActions } from "./desktop-actions"
import { useSkillMarket } from "./provider"
import { scoreLabel } from "./score-label"
import type { SkillKey } from "./types"

type MarketScope = "all" | "featured" | "enterprise" | "community" | "installed" | "updates"
type MarketView = "card" | "list"
type ApiKeyFilter = "all" | "yes" | "no"

const sortTabs = [
  { label: "全部", sort: "score", scope: "all" },
  { label: "推荐精选", sort: "featured", scope: "featured" },
  { label: "近期飙升", sort: "trending", scope: "all" },
  { label: "下载量", sort: "downloads", scope: "all" },
  { label: "最近上新", sort: "recent", scope: "all" },
] as const

export function SkillMarketList(props: {
  onOpen: (key: SkillKey) => void
  onSubmit?: () => void
  submitHref?: string
  installedOnly?: boolean
}) {
  const market = useSkillMarket()
  const initial = new URLSearchParams(window.location.search)
  const initialSort = parseSort(initial.get("sort"))
  const initialSource = parseSource(initial.get("source"))
  const [state, setState] = createStore({
    search: initial.get("q") ?? "",
    debounced: initial.get("q") ?? "",
    source: initialSource,
    category: initial.get("category") ?? "",
    apiKey: parseApiKey(initial.get("apiKey")),
    sort: initialSort,
    scope: (props.installedOnly && market.source.installed
      ? "installed"
      : initialSource === "community"
        ? "community"
        : initialSort === "featured"
          ? "featured"
          : "all") as MarketScope,
    page: parsePage(initial.get("page")),
    view: (localStorage.getItem("ruying-skill-market-view") === "list" ? "list" : "card") as MarketView,
  })

  createEffect(() => {
    const value = state.search
    const timer = window.setTimeout(() => {
      setState({ debounced: value, page: 1 })
    }, 300)
    onCleanup(() => window.clearTimeout(timer))
  })

  createEffect(() => {
    const params = new URLSearchParams()
    if (state.search.trim()) params.set("q", state.search.trim())
    if (state.sort !== "score") params.set("sort", state.sort)
    if (state.source) params.set("source", state.source)
    if (state.category) params.set("category", state.category)
    if (state.apiKey !== "all") params.set("apiKey", state.apiKey)
    if (state.page > 1) params.set("page", String(state.page))
    window.history.replaceState(undefined, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`)
  })

  const query = createMemo<SkillMarket.PageQuery>(() => ({
    query: state.debounced.trim() || undefined,
    source: state.source || undefined,
    category: state.category || undefined,
    requiresApiKey: state.apiKey === "all" ? undefined : state.apiKey === "yes",
    featured: state.scope === "featured" ? true : undefined,
    enterprise: state.scope === "enterprise" ? true : undefined,
    sort: state.sort,
    page: state.page,
    limit: 30,
  }))
  const catalogEnabled = () => state.scope !== "installed" && state.scope !== "updates"
  const result = createQuery(() => ({
    queryKey: ["skill-market", "list", query()] as const,
    queryFn: ({ signal }) => market.source.list(query(), signal),
    enabled: catalogEnabled(),
    placeholderData: (previous) => previous,
  }))
  const facets = createQuery(() => ({
    queryKey: ["skill-market", "facets"] as const,
    queryFn: ({ signal }) => market.source.facets(signal),
  }))
  const installed = createQuery(() => ({
    queryKey: ["skill-market", "installed"] as const,
    queryFn: ({ signal }) => market.source.installed?.(signal) ?? Promise.resolve([]),
    enabled: state.scope === "installed" && market.source.installed !== undefined,
  }))
  const updates = createQuery(() => ({
    queryKey: ["skill-market", "updates"] as const,
    queryFn: ({ signal }) => market.source.updates?.(signal) ?? Promise.resolve([]),
    enabled: state.scope === "updates" && market.source.updates !== undefined,
  }))

  const selectSort = (sort: SkillMarket.Sort, scope: MarketScope) => {
    setState({ sort, scope, page: 1, source: state.scope === "community" ? "" : state.source })
  }

  return (
    <main class="ruying-skill-market">
      <header class="ruying-skill-market__hero">
        <div>
          <span class="ruying-skill-market__eyebrow">RUYING CODE</span>
          <h1>Skill 市场</h1>
          <p>发现经过聚合与校验的开发技能，让如影 Code 更懂你的工作方式。</p>
        </div>
        <div class="ruying-skill-market__hero-actions">
          <label class="ruying-skill-market__search">
            <span class="ruying-skill-market__sr-only">搜索 Skill</span>
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={state.search}
              onInput={(event) => setState("search", event.currentTarget.value)}
              placeholder="搜索 Skill、场景或标签"
            />
          </label>
          <Show
            when={props.submitHref}
            fallback={
              <Show when={props.onSubmit}>
                {(onSubmit) => (
                  <button type="button" class="ruying-skill-market__submit" onClick={onSubmit()}>
                    投稿 Skill
                  </button>
                )}
              </Show>
            }
          >
            {(href) => (
              <a class="ruying-skill-market__submit" href={href()}>
                投稿 Skill
              </a>
            )}
          </Show>
        </div>
      </header>

      <nav class="ruying-skill-market__tabs" aria-label="市场排序">
        <For each={sortTabs}>
          {(tab) => (
            <button
              type="button"
              classList={{
                "ruying-skill-market__tab": true,
                "ruying-skill-market__tab--active": state.scope === tab.scope && state.sort === tab.sort,
              }}
              aria-pressed={state.scope === tab.scope && state.sort === tab.sort}
              onClick={() => selectSort(tab.sort, tab.scope)}
            >
              {tab.label}
            </button>
          )}
        </For>
        <button
          type="button"
          classList={{
            "ruying-skill-market__tab": true,
            "ruying-skill-market__tab--active": state.scope === "enterprise",
          }}
          aria-pressed={state.scope === "enterprise"}
          onClick={() => selectSort("score", "enterprise")}
        >
          企业精选
        </button>
        <button
          type="button"
          classList={{
            "ruying-skill-market__tab": true,
            "ruying-skill-market__tab--active": state.scope === "community",
          }}
          aria-pressed={state.scope === "community"}
          onClick={() => setState({ source: "community", sort: "score", scope: "community", page: 1 })}
        >
          用户投稿
        </button>
        <Show when={market.source.installed}>
          <button
            type="button"
            classList={{
              "ruying-skill-market__tab": true,
              "ruying-skill-market__tab--active": state.scope === "installed",
            }}
            aria-pressed={state.scope === "installed"}
            onClick={() => setState({ scope: "installed", page: 1 })}
          >
            已安装
          </button>
        </Show>
        <Show when={market.source.updates}>
          <button
            type="button"
            classList={{
              "ruying-skill-market__tab": true,
              "ruying-skill-market__tab--active": state.scope === "updates",
            }}
            aria-pressed={state.scope === "updates"}
            onClick={() => setState({ scope: "updates", page: 1 })}
          >
            可更新
          </button>
        </Show>
      </nav>

      <Show when={catalogEnabled()}>
        <section class="ruying-skill-market__toolbar" aria-label="市场筛选">
          <label>
            <span>来源</span>
            <select
              value={state.source}
              onChange={(event) => {
                const source = parseSource(event.currentTarget.value)
                setState({
                  source,
                  scope: source === "community" ? "community" : state.scope === "community" ? "all" : state.scope,
                  page: 1,
                })
              }}
            >
              <option value="">全部来源</option>
              <option value="enterprise">企业精选</option>
              <option value="skillhub">SkillHub</option>
              <option value="community">用户投稿</option>
            </select>
          </label>
          <label>
            <span>场景分类</span>
            <select
              value={state.category}
              onChange={(event) => setState({ category: event.currentTarget.value, page: 1 })}
            >
              <option value="">全部分类</option>
              <For each={facets.data?.categories}>
                {(category) => <option value={category.value}>{category.value}</option>}
              </For>
            </select>
          </label>
          <label>
            <span>API Key</span>
            <select
              value={state.apiKey}
              onChange={(event) => setState({ apiKey: parseApiKey(event.currentTarget.value), page: 1 })}
            >
              <option value="all">不限</option>
              <option value="no">无需 API Key</option>
              <option value="yes">需要 API Key</option>
            </select>
          </label>
          <div class="ruying-skill-market__view-switch" aria-label="展示方式">
            <button
              type="button"
              aria-label="卡片视图"
              aria-pressed={state.view === "card"}
              onClick={() => {
                setState("view", "card")
                localStorage.setItem("ruying-skill-market-view", "card")
              }}
            >
              ▦
            </button>
            <button
              type="button"
              aria-label="列表视图"
              aria-pressed={state.view === "list"}
              onClick={() => {
                setState("view", "list")
                localStorage.setItem("ruying-skill-market-view", "list")
              }}
            >
              ☷
            </button>
          </div>
        </section>

        <Show when={isPartial(result.data?.sourceStatus)}>
          <div class="ruying-skill-market__source-status" role="status">
            部分来源数据暂不可用或不是最新版本，当前结果来自最近一次可信快照。
          </div>
        </Show>
        <Show when={result.isPending}>
          <div class="ruying-skill-market__state" role="status">
            正在加载 Skill…
          </div>
        </Show>
        <Show when={result.isError}>
          <div class="ruying-skill-market__state ruying-skill-market__state--error" role="alert">
            市场暂时无法访问，请稍后重试。
          </div>
        </Show>
        <Show when={result.data && result.data.items.length === 0}>
          <div class="ruying-skill-market__empty">
            <strong>没有找到匹配的 Skill</strong>
            <span>试试更短的关键词，或者调整来源与分类筛选。</span>
          </div>
        </Show>
        <Show when={result.data && result.data.items.length > 0}>
          <CatalogResults items={result.data?.items ?? []} view={state.view} onOpen={props.onOpen} />
          <div class="ruying-skill-market__pagination" aria-label="分页">
            <button type="button" disabled={state.page <= 1} onClick={() => setState("page", state.page - 1)}>
              上一页
            </button>
            <span>
              第 {state.page} 页 · 共 {formatTotal(result.data?.total ?? 0)} 个 Skill
            </span>
            <button
              type="button"
              disabled={state.page * 30 >= (result.data?.total ?? 0)}
              onClick={() => setState("page", state.page + 1)}
            >
              下一页
            </button>
          </div>
        </Show>
      </Show>

      <Show when={state.scope === "installed"}>
        <InstalledSkills
          items={installed.data ?? []}
          pending={installed.isPending}
          actions={market.actions}
          onOpen={props.onOpen}
        />
      </Show>
      <Show when={state.scope === "updates"}>
        <UpdateSkills items={updates.data ?? []} pending={updates.isPending} onOpen={props.onOpen} />
      </Show>
    </main>
  )
}

function CatalogResults(props: {
  items: readonly SkillMarket.Summary[]
  view: MarketView
  onOpen: (key: SkillKey) => void
}) {
  return (
    <div class="ruying-skill-market__results" data-view={props.view}>
      <For each={props.items}>
        {(item) => <SkillCard item={item} view={props.view} onOpen={props.onOpen} />}
      </For>
    </div>
  )
}

function SkillCard(props: { item: SkillMarket.Summary; view: MarketView; onOpen: (key: SkillKey) => void }) {
  const [state, setState] = createStore({ iconFailed: false })
  const key = () => ({ source: props.item.source, id: props.item.id })

  return (
    <button
      type="button"
      class="ruying-skill-market__card"
      data-view={props.view}
      aria-label={`${props.item.name}，${props.item.description}`}
      onClick={() => props.onOpen(key())}
    >
      <div class="ruying-skill-market__icon">
        <Show
          when={props.item.iconUrl && !state.iconFailed ? props.item.iconUrl : undefined}
          fallback={
            <span aria-label={`${props.item.name} 默认图标`}>
              {props.item.name.trim().charAt(0).toUpperCase() || "S"}
            </span>
          }
        >
          {(url) => (
            <img
              src={url()}
              alt={`${props.item.name} 图标`}
              loading="lazy"
              onError={() => setState("iconFailed", true)}
            />
          )}
        </Show>
      </div>
      <div class="ruying-skill-market__card-body">
        <div class="ruying-skill-market__card-title">
          <strong>{props.item.name}</strong>
          <Show when={props.item.installedVersion}>
            <span class="ruying-skill-market__installed-state">{props.item.updateAvailable ? "可更新" : "已安装"}</span>
          </Show>
          <span class={`ruying-skill-market__risk ruying-skill-market__risk--${props.item.risk}`}>
            {riskLabel(props.item.risk)}
          </span>
        </div>
        <p>{props.item.description}</p>
        <div class="ruying-skill-market__card-meta">
          <span>{sourceLabel(props.item.source)}</span>
          <span>v{props.item.version}</span>
          <span>↓ {formatNumber(props.item.downloads)}</span>
          <span>评分 {scoreLabel(props.item)}</span>
        </div>
      </div>
      <span class="ruying-skill-market__card-arrow" aria-hidden="true">
        →
      </span>
    </button>
  )
}

function InstalledSkills(props: {
  items: readonly SkillMarket.Installed[]
  pending: boolean
  actions: ReturnType<typeof useSkillMarket>["actions"]
  onOpen: (key: SkillKey) => void
}) {
  return (
    <section class="ruying-skill-market__local" aria-label="已安装 Skill">
      <Show when={props.pending}>
        <div class="ruying-skill-market__state" role="status">
          正在读取已安装 Skill…
        </div>
      </Show>
      <Show when={!props.pending && props.items.length === 0}>
        <div class="ruying-skill-market__empty">
          <strong>还没有安装 Skill</strong>
          <span>返回市场挑选适合你的开发技能。</span>
        </div>
      </Show>
      <For each={props.items}>
        {(item) => (
          <article class="ruying-skill-market__installed">
            <button type="button" class="ruying-skill-market__installed-main" onClick={() => props.onOpen(item)}>
              <strong>{item.name}</strong>
              <span>
                {sourceLabel(item.source)} · v{item.version}
              </span>
            </button>
            <Show when={item.loadState === "refresh-failed"}>
              <span class="ruying-skill-market__load-failed">加载失败</span>
            </Show>
            <Show when={props.actions.kind === "desktop"}>
              <DesktopInstalledActions item={item} />
            </Show>
          </article>
        )}
      </For>
    </section>
  )
}

function UpdateSkills(props: {
  items: readonly SkillMarket.Installed[]
  pending: boolean
  onOpen: (key: SkillKey) => void
}) {
  return (
    <section class="ruying-skill-market__local" aria-label="可更新 Skill">
      <Show when={props.pending}>
        <div class="ruying-skill-market__state" role="status">
          正在检查更新…
        </div>
      </Show>
      <Show when={!props.pending && props.items.length === 0}>
        <div class="ruying-skill-market__empty">
          <strong>所有 Skill 都是最新版本</strong>
          <span>有新版本时会在这里集中显示。</span>
        </div>
      </Show>
      <For each={props.items}>
        {(item) => (
          <button type="button" class="ruying-skill-market__installed" onClick={() => props.onOpen(item)}>
            <span class="ruying-skill-market__installed-main">
              <strong>{item.name}</strong>
              <span>当前版本 v{item.version}</span>
            </span>
            <span>查看更新 →</span>
          </button>
        )}
      </For>
    </section>
  )
}

function parseSort(value: string | null): SkillMarket.Sort {
  if (value === "featured" || value === "trending" || value === "downloads" || value === "recent") return value
  return "score"
}

function parseSource(value: string | null): SkillMarket.Source | "" {
  if (value === "skillhub" || value === "enterprise" || value === "community") return value
  return ""
}

function parseApiKey(value: string | null): ApiKeyFilter {
  if (value === "yes" || value === "no") return value
  return "all"
}

function parsePage(value: string | null) {
  const page = Number(value)
  if (Number.isInteger(page) && page > 0) return page
  return 1
}

function isPartial(status?: SkillMarket.SourceStatus) {
  if (!status) return false
  return status.skillhub !== "fresh" || status.enterprise !== "fresh" || status.community !== "fresh"
}

function sourceLabel(source: SkillMarket.Source) {
  if (source === "enterprise") return "企业精选"
  if (source === "community") return "用户投稿"
  return "SkillHub"
}

function riskLabel(risk: SkillMarket.Risk) {
  if (risk === "safe") return "安全"
  if (risk === "warning") return "注意"
  if (risk === "danger") return "高风险"
  return "待检测"
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

function formatTotal(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value)
}
