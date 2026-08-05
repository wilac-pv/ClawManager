import { A } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Show, createSignal } from "solid-js"
import type { SkillMarketControlDataSource } from "../control-data-source"

export function GroupAdministration(props: { readonly source: Pick<SkillMarketControlDataSource["groups"], "list"> }) {
  const [query, setQuery] = createSignal("")
  const groups = createQuery(() => ({ queryKey: ["skill-market", "admin", "groups"] as const, queryFn: ({ signal }) => props.source.list(signal) }))
  const filtered = () => groups.data?.managed.filter((group) => `${group.name} ${group.id} ${group.ownerEmployeeID}`.toLowerCase().includes(query().trim().toLowerCase())) ?? []
  return (
    <main class="submission-page admin-groups">
      <header class="submission-page__heading"><div><p class="submission-page__eyebrow">Admin workspace</p><h1>小组管理</h1><p>查找并管理全公司的分享小组。</p></div></header>
      <label class="admin-group-search"><span>查找小组</span><input aria-label="查找小组" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} /></label>
      <Show when={!groups.isPending} fallback={<section class="submission-state" role="status">正在加载小组…</section>}>
        <div class="moderation-table-wrap"><table class="moderation-table"><thead><tr><th>小组</th><th>负责人</th><th>状态</th><th>操作</th></tr></thead><tbody>
          <For each={filtered()}>{(group) => <tr><td><strong>{group.name}</strong><small>{group.id}</small></td><td>{group.ownerEmployeeID}</td><td>{group.status === "active" ? "启用" : "已停用"}</td><td><A href={`/groups/${encodeURIComponent(group.id)}`}>管理</A></td></tr>}</For>
        </tbody></table></div>
      </Show>
    </main>
  )
}
