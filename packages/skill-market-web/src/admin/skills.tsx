import { A, useSearchParams } from "@solidjs/router"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { Match, Show, Switch, For, createSignal } from "solid-js"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"

export type AdminSkillsSource = Pick<
  SkillMarketControlDataSource["admin"]["skills"],
  "list" | "hiddenCategories" | "update" | "delist" | "restore" | "delete" | "delistByCategory" | "restoreByCategory"
>

export function AdminSkills(props: { source: AdminSkillsSource }) {
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [categoryAction, setCategoryAction] = createSignal<"hide" | "show" | undefined>()
  const [categoryValue, setCategoryValue] = createSignal("")
  const [categoryReason, setCategoryReason] = createSignal("")

  const page = () => {
    const parsed = Number(params.page)
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
  }
  const stringParam = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value
  const filters = () => ({
    page: page(),
    limit: 30,
    query: stringParam(params.q) || undefined,
    source: (stringParam(params.source) as SkillMarket.Source) || undefined,
    category: stringParam(params.category) || undefined,
    hidden: stringParam(params.hidden) === "true" ? true : stringParam(params.hidden) === "false" ? false : undefined,
    featured: stringParam(params.featured) === "true" ? true : stringParam(params.featured) === "false" ? false : undefined,
  })

  const skills = createQuery(() => ({
    queryKey: ["skill-market", "admin", "skills", filters()] as const,
    queryFn: ({ signal }) => props.source.list(filters(), signal),
  }))

  const hiddenCategories = createQuery(() => ({
    queryKey: ["skill-market", "admin", "skills", "hidden-categories"] as const,
    queryFn: ({ signal }) => props.source.hiddenCategories(signal),
  }))

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["skill-market", "admin", "skills"] })
    void client.invalidateQueries({ queryKey: ["skill-market", "admin", "skills", "hidden-categories"] })
  }

  const updateParams = (next: Partial<typeof params>) => {
    setParams({ ...next, page: "1" })
  }

  const categoryActionSubmit = () => {
    const category = categoryValue().trim()
    if (!category) return
    const input = { category, reason: categoryReason().trim() || undefined }
    const operation = categoryAction() === "hide"
      ? props.source.delistByCategory(input)
      : props.source.restoreByCategory(input)
    void operation
      .then(() => {
        setCategoryAction(undefined)
        setCategoryValue("")
        setCategoryReason("")
        invalidate()
      })
      .catch(() => {})
  }

  return (
    <main class="submission-page moderation-page">
      <header class="submission-page__heading">
        <h1 class="type-page-title">技能管理</h1>
        <p class="type-secondary">管理市场技能的可见性、精选标记和分类</p>
      </header>

      <section class="moderation-filters" aria-label="技能筛选">
        <label>
          <span>搜索</span>
          <input
            type="search"
            value={params.q ?? ""}
            onInput={(event) => updateParams({ q: event.currentTarget.value || undefined })}
            placeholder="技能名称、描述或标签"
          />
        </label>
        <label>
          <span>来源</span>
          <select
            value={params.source ?? ""}
            onChange={(event) => updateParams({ source: event.currentTarget.value || undefined })}
          >
            <option value="">全部</option>
            <option value="skillhub">SkillHub</option>
            <option value="enterprise">企业精选</option>
            <option value="community">用户投稿</option>
          </select>
        </label>
        <label>
          <span>分类</span>
          <select
            value={params.category ?? ""}
            onChange={(event) => updateParams({ category: event.currentTarget.value || undefined })}
          >
            <option value="">全部</option>
            <For each={skills.data?.items?.map((item) => item.skill.categories[0]).filter(Boolean) ?? []}>
              {(category) => <option value={category}>{category}</option>}
            </For>
          </select>
        </label>
        <label>
          <span>状态</span>
          <select
            value={params.hidden ?? ""}
            onChange={(event) => updateParams({ hidden: event.currentTarget.value || undefined })}
          >
            <option value="">全部</option>
            <option value="false">正常</option>
            <option value="true">已隐藏</option>
          </select>
        </label>
        <label>
          <span>精选</span>
          <select
            value={params.featured ?? ""}
            onChange={(event) => updateParams({ featured: event.currentTarget.value || undefined })}
          >
            <option value="">全部</option>
            <option value="true">精选</option>
            <option value="false">非精选</option>
          </select>
        </label>
        <div>
          <button type="button" onClick={() => void skills.refetch()}>刷新</button>
        </div>
      </section>

      <section class="submission-detail__section">
        <div class="submission-detail__section-heading">
          <h2>分类批量操作</h2>
          <button
            type="button"
            onClick={() => {
              setCategoryAction("hide")
              setCategoryValue("")
              setCategoryReason("")
            }}
          >
            隐藏分类
          </button>
          <button
            type="button"
            onClick={() => {
              setCategoryAction("show")
              setCategoryValue("")
              setCategoryReason("")
            }}
          >
            显示分类
          </button>
        </div>
        <Show when={categoryAction()}>
          <div class="admin-operation-confirmation">
            <p>{categoryAction() === "hide" ? "输入要隐藏的分类，该分类下所有技能将从市场消失：" : "输入要恢复显示的分类："}</p>
            <input
              type="text"
              value={categoryValue()}
              onInput={(event) => setCategoryValue(event.currentTarget.value)}
              placeholder="分类名称，如：办公效率"
            />
            <Show when={categoryAction() === "hide"}>
              <input
                type="text"
                value={categoryReason()}
                onInput={(event) => setCategoryReason(event.currentTarget.value)}
                placeholder="隐藏原因（可选）"
              />
            </Show>
            <div>
              <button type="button" onClick={() => setCategoryAction(undefined)}>取消</button>
              <button type="button" class="market-primary-action" onClick={categoryActionSubmit}>
                确认{categoryAction() === "hide" ? "隐藏" : "显示"}
              </button>
            </div>
          </div>
        </Show>
        <Show when={hiddenCategories.data?.items?.length}>
          <div style="margin-top: 12px; font-size: 13px; color: var(--skillhub-muted);">
            已隐藏分类：
            <For each={hiddenCategories.data?.items ?? []}>
              {(item) => (
                <span style="display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; padding: 2px 8px; border-radius: 999px; background: var(--skillhub-warning-soft); color: var(--skillhub-warning);">
                  {item.category}
                  <button
                    type="button"
                    style="border: 0; background: transparent; color: inherit; cursor: pointer;"
                    onClick={() => {
                      void props.source.restoreByCategory({ category: item.category }).then(invalidate)
                    }}
                  >
                    ×
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
      </section>

      <Switch>
        <Match when={skills.isPending}>
          <section class="submission-state" role="status">
            正在加载技能列表…
          </section>
        </Match>
        <Match when={skills.error}>
          <section class="submission-state" role="alert">
            <h1 class="type-page-title">技能列表加载失败</h1>
            <p class="type-body">请检查网络后重试。</p>
            <button type="button" onClick={() => void skills.refetch()}>重新加载</button>
          </section>
        </Match>
        <Match when={skills.data}>
          {(result) => (
            <Show
              when={result().items.length > 0}
              fallback={
                <section class="submission-detail__section">
                  <p class="type-body">没有符合条件的技能。</p>
                </section>
              }
            >
              <div class="admin-skill-grid">
                <For each={result().items}>
                  {(item) => (
                    <AdminSkillCard
                      item={item}
                      source={props.source}
                      onChanged={invalidate}
                    />
                  )}
                </For>
              </div>
              <AdminSkillsPagination current={result().page} total={result().total} limit={result().limit} />
            </Show>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function AdminSkillCard(props: {
  item: SkillMarketControl.SkillAdminItem
  source: AdminSkillsSource
  onChanged: () => void
}) {
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [editing, setEditing] = createSignal(false)
  const [featured, setFeatured] = createSignal(props.item.skill.featured)
  const [category, setCategory] = createSignal(props.item.skill.categories[0] ?? "")
  const [hiddenReason, setHiddenReason] = createSignal(props.item.override?.hiddenReason ?? "")
  const [deleteReason, setDeleteReason] = createSignal("")

  const isHidden = () => props.item.skill.delisted || props.item.override?.hidden
  const isCommunity = () => props.item.skill.source === "community"

  const saveEdit = () => {
    setPending(true)
    setError(undefined)
    const input: SkillMarketControl.SkillAdminEditInput = {
      featured: featured(),
      category: category().trim() || undefined,
    }
    void props.source
      .update(props.item.skill.source, props.item.skill.id, input)
      .then(() => {
        props.onChanged()
        setEditing(false)
      })
      .catch((cause: unknown) =>
        setError(cause instanceof MarketControlError ? `${cause.message}（请求编号：${cause.requestId}）` : "保存失败"),
      )
      .finally(() => setPending(false))
  }

  const setHidden = (hidden: boolean) => {
    setPending(true)
    setError(undefined)
    const reason = hidden ? hiddenReason().trim() || "管理员操作" : "恢复展示"
    const operation = hidden
      ? props.source.delist(props.item.skill.source, props.item.skill.id, { reason }, crypto.randomUUID())
      : props.source.restore(props.item.skill.source, props.item.skill.id, { reason }, crypto.randomUUID())
    void operation
      .then(() => props.onChanged())
      .catch((cause: unknown) =>
        setError(cause instanceof MarketControlError ? `${cause.message}（请求编号：${cause.requestId}）` : "操作失败"),
      )
      .finally(() => setPending(false))
  }

  const deleteSkill = () => {
    if (!window.confirm(`确定要永久删除技能「${props.item.skill.name}」吗？此操作不可恢复。`)) return
    setPending(true)
    setError(undefined)
    void props.source
      .delete(props.item.skill.source, props.item.skill.id, { reason: deleteReason().trim() || "管理员删除" }, crypto.randomUUID())
      .then(() => props.onChanged())
      .catch((cause: unknown) =>
        setError(cause instanceof MarketControlError ? `${cause.message}（请求编号：${cause.requestId}）` : "删除失败"),
      )
      .finally(() => setPending(false))
  }

  return (
    <article class="admin-skill-card">
      <div class="admin-skill-card__top">
        <div class="admin-skill-card__icon">
          <Show
            when={props.item.skill.iconUrl}
            fallback={<span>{props.item.skill.name.trim().charAt(0).toUpperCase() || "S"}</span>}
          >
            {(url) => <img src={url()} alt="" loading="lazy" />}
          </Show>
        </div>
        <div class="admin-skill-card__heading">
          <div class="admin-skill-card__title">
            <A href={`/skills/${props.item.skill.source}/${props.item.skill.id}`}>
              <strong>{props.item.skill.name}</strong>
            </A>
            <Show when={props.item.skill.featured}>
              <span class="admin-skill-card__verified" aria-label="精选">✓</span>
            </Show>
          </div>
          <div class="admin-skill-card__tags">
            <span class="admin-skill-card__tag admin-skill-card__tag--category">
              {props.item.skill.categories[0] ?? "未分类"}
            </span>
            <Show when={props.item.skill.requiresApiKey}>
              <span class="admin-skill-card__tag admin-skill-card__tag--apikey">需配置 API Key</span>
            </Show>
          </div>
        </div>
      </div>
      <p class="admin-skill-card__description">{props.item.skill.description}</p>
      <div class="admin-skill-card__meta">
        <span>⭐ {props.item.skill.favorites}</span>
        <span>↓ {props.item.skill.downloads}</span>
        <span>{sourceLabel(props.item.skill.source)}</span>
        <Show when={isHidden()}>
          <span class="admin-skill-card__hidden-badge">已隐藏</span>
        </Show>
      </div>
      <Show when={props.item.override}>
        {(override) => (
          <div class="admin-skill-card__override-note">
            本地覆盖 · {override().updatedBy} · {new Date(override().updatedAt).toLocaleString()}
          </div>
        )}
      </Show>
      <Show
        when={!editing()}
        fallback={
          <div class="admin-skill-card__edit-form">
            <label>
              <input type="checkbox" checked={featured()} onChange={(event) => setFeatured(event.currentTarget.checked)} />
              精选
            </label>
            <input
              type="text"
              value={category()}
              onInput={(event) => setCategory(event.currentTarget.value)}
              placeholder="分类"
            />
            <div class="admin-skill-card__actions">
              <button type="button" class="market-primary-action" disabled={pending()} onClick={saveEdit}>
                保存
              </button>
              <button type="button" onClick={() => setEditing(false)}>取消</button>
            </div>
          </div>
        }
      >
        <div class="admin-skill-card__actions">
          <button type="button" onClick={() => setEditing(true)} disabled={pending()}>
            编辑
          </button>
          <Show
            when={!isHidden()}
            fallback={
              <button type="button" class="market-primary-action" disabled={pending()} onClick={() => setHidden(false)}>
                恢复
              </button>
            }
          >
            <button type="button" class="admin-danger-action" disabled={pending()} onClick={() => setHidden(true)}>
              下架
            </button>
          </Show>
          <button type="button" class="admin-danger-action" disabled={pending()} onClick={deleteSkill}>
            删除
          </button>
        </div>
      </Show>
      <Show when={error()}>
        {(message) => <div class="delist-row-error" role="alert">{message()}</div>}
      </Show>
    </article>
  )
}

function AdminSkillsPagination(props: { current: number; total: number; limit: number }) {
  const pages = () => Math.max(1, Math.ceil(props.total / props.limit))
  const pageUrl = (page: number) => `/admin/skills?page=${page}`
  return (
    <nav class="submission-pagination" aria-label="技能管理分页">
      <Show when={props.current > 1} fallback={<span aria-hidden="true" />}>
        <A href={pageUrl(props.current - 1)}>上一页</A>
      </Show>
      <span>
        第 {props.current} / {pages()} 页
      </span>
      <Show when={props.current < pages()} fallback={<span aria-hidden="true" />}>
        <A href={pageUrl(props.current + 1)}>下一页</A>
      </Show>
    </nav>
  )
}

function sourceLabel(source: SkillMarket.Source) {
  if (source === "enterprise") return "企业精选"
  if (source === "community") return "用户投稿"
  if (source === "restricted") return "受限"
  return "SkillHub"
}
