import { A } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createSignal } from "solid-js"
import type { SkillMarketControlDataSource } from "../control-data-source"
import { SpacePageHeader } from "../space/page"

export type GroupListSource = Pick<SkillMarketControlDataSource["groups"], "list" | "create">

export function GroupList(props: { readonly source: GroupListSource }) {
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const groups = createQuery(() => ({
    queryKey: ["skill-market", "groups"] as const,
    queryFn: ({ signal }) => props.source.list(signal),
  }))
  const create = (event: SubmitEvent) => {
    event.preventDefault()
    if (!name().trim() || pending()) return
    setPending(true)
    setError(undefined)
    void props.source
      .create({ name: name().trim(), ...(description().trim() ? { description: description().trim() } : {}) })
      .then(() => {
        setName("")
        setDescription("")
        void groups.refetch()
      })
      .catch(() => setError("创建小组失败，请稍后重试。"))
      .finally(() => setPending(false))
  }

  return (
    <main class="submission-page space-page group-page">
      <SpacePageHeader
        eyebrow="共享小组"
        title="我的小组"
        description="维护可复用的成员范围，用于将 Skill 安全地分享给指定同事。"
        action={<></>}
      />
      <form class="group-create-form" onSubmit={create}>
        <label>
          <span>小组名称</span>
          <input aria-label="小组名称" value={name()} onInput={(event) => setName(event.currentTarget.value)} />
        </label>
        <label>
          <span>说明（可选）</span>
          <input aria-label="说明（可选）" value={description()} onInput={(event) => setDescription(event.currentTarget.value)} />
        </label>
        <button type="submit" class="market-primary-action" disabled={!name().trim() || pending()}>
          {pending() ? "正在创建…" : "创建小组"}
        </button>
      </form>
      <Show when={error()}>{(message) => <p class="submission-form__errors" role="alert">{message()}</p>}</Show>
      <Switch>
        <Match when={groups.isPending}><section class="submission-state" role="status">正在加载小组…</section></Match>
        <Match when={groups.error}><section class="submission-state" role="alert">小组加载失败。</section></Match>
        <Match when={groups.data}>
          {(page) => (
            <div class="group-sections">
              <GroupSection title="我管理的小组" groups={page().managed} empty="还没有管理的小组。" />
              <GroupSection title="我加入的小组" groups={page().joined} empty="还没有加入其他小组。" />
            </div>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function GroupSection(props: { title: string; groups: Awaited<ReturnType<GroupListSource["list"]>>["managed"]; empty: string }) {
  return (
    <section class="group-section">
      <h2>{props.title}</h2>
      <Show when={props.groups.length > 0} fallback={<p>{props.empty}</p>}>
        <div class="group-grid">
          <For each={props.groups}>
            {(group) => (
              <A class="group-card" href={`/groups/${encodeURIComponent(group.id)}`}>
                <span><strong>{group.name}</strong><small>{group.status === "active" ? "启用" : "已停用"}</small></span>
                <p>{group.description ?? "暂无说明"}</p>
                <small>负责人：{group.ownerEmployeeID}</small>
              </A>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
