import { A, useSearchParams } from "@solidjs/router"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { Match, Show, Switch, For, createSignal } from "solid-js"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"

export type AdminSkillsSource = Pick<
  SkillMarketControlDataSource["admin"]["skills"],
  "list" | "hiddenCategories" | "update" | "delist" | "restore" | "delistByCategory" | "restoreByCategory"
>

export function AdminSkills(props: { source: AdminSkillsSource }) {
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = createSignal<string | undefined>()
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
              <div class="moderation-table-wrapper">
                <table class="moderation-table">
                  <thead>
                    <tr>
                      <th scope="col">技能</th>
                      <th scope="col">分类</th>
                      <th scope="col">精选</th>
                      <th scope="col">状态</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={result().items}>
                      {(item) => (
                        <AdminSkillRow
                          item={item}
                          source={props.source}
                          editing={editing() === `${item.skill.source}:${item.skill.id}`}
                          onEditStart={() => setEditing(`${item.skill.source}:${item.skill.id}`)}
                          onEditEnd={() => setEditing(undefined)}
                          onChanged={invalidate}
                        />
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <AdminSkillsPagination current={result().page} total={result().total} limit={result().limit} />
            </Show>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function AdminSkillRow(props: {
  item: SkillMarketControl.SkillAdminItem
  source: AdminSkillsSource
  editing: boolean
  onEditStart: () => void
  onEditEnd: () => void
  onChanged: () => void
}) {
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [featured, setFeatured] = createSignal(props.item.skill.featured)
  const [category, setCategory] = createSignal(props.item.skill.categories[0] ?? "")
  const [hiddenReason, setHiddenReason] = createSignal(props.item.override?.hiddenReason ?? "")

  const skillKey = () => `${props.item.skill.source}:${props.item.skill.id}`
  const isHidden = () => props.item.skill.delisted || props.item.override?.hidden
  const isCommunity = () => props.item.skill.source === "community"

  const saveEdit = () => {
    setPending(true)
    setError(undefined)
    const input: SkillMarketControl.SkillAdminEditInput = {
      ...(isCommunity() ? { featured: featured(), category: category().trim() || undefined } : {}),
      ...(!isCommunity() ? { featured: featured(), category: category().trim() || undefined } : {}),
    }
    void props.source
      .update(props.item.skill.source, props.item.skill.id, input)
      .then(() => {
        props.onChanged()
        props.onEditEnd()
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

  return (
    <tr>
      <td>
        <div style="min-width: 200px;">
          <A href={`/skills/${props.item.skill.source}/${props.item.skill.id}`}>
            <strong>{props.item.skill.name}</strong>
          </A>
          <small style="display: block; margin-top: 2px; color: var(--skillhub-muted);">
            {props.item.skill.source} · {props.item.skill.id}
          </small>
          <Show when={props.item.override}>
            {(override) => (
              <small style="display: block; margin-top: 2px; color: var(--skillhub-warning);">
                有本地覆盖 · {override().updatedBy} · {new Date(override().updatedAt).toLocaleString()}
              </small>
            )}
          </Show>
        </div>
      </td>
      <td>
        <Show when={!props.editing} fallback={
          <input
            type="text"
            value={category()}
            onInput={(event) => setCategory(event.currentTarget.value)}
            style="width: 100px; padding: 4px 6px;"
          />
        }>
          <span class="type-body">{props.item.skill.categories[0] ?? "-"}</span>
        </Show>
      </td>
      <td>
        <Show when={!props.editing} fallback={
          <label style="display: flex; align-items: center; gap: 4px;">
            <input type="checkbox" checked={featured()} onChange={(event) => setFeatured(event.currentTarget.checked)} />
            精选
          </label>
        }>
          <span class={`submission-status ${props.item.skill.featured ? "submission-status--published" : ""}`}>
            {props.item.skill.featured ? "精选" : "-"}
          </span>
        </Show>
      </td>
      <td>
        <span class={`submission-status ${isHidden() ? "submission-status--rejected" : "submission-status--published"}`}>
          {isHidden() ? "已隐藏" : "正常"}
        </span>
      </td>
      <td>
        <Show
          when={!props.editing}
          fallback={
            <div class="delist-row-actions">
              <button type="button" class="market-primary-action" disabled={pending()} onClick={saveEdit}>
                保存
              </button>
              <button type="button" onClick={() => props.onEditEnd()}>取消</button>
              <Show when={error()}>
                {(message) => <span class="delist-row-error" role="alert">{message()}</span>}
              </Show>
            </div>
          }
        >
          <div class="delist-row-actions">
            <button type="button" onClick={() => props.onEditStart()} disabled={pending()}>
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
            <Show when={error()}>
              {(message) => <span class="delist-row-error" role="alert">{message()}</span>}
            </Show>
          </div>
        </Show>
      </td>
    </tr>
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
