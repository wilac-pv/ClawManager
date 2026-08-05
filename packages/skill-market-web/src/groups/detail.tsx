import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { createQuery } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createSignal } from "solid-js"
import type { SkillMarketControlDataSource } from "../control-data-source"

export type GroupDetailSource = Pick<
  SkillMarketControlDataSource["groups"],
  "detail" | "members" | "update" | "transfer" | "setStatus" | "addMember" | "removeMember"
>

export function GroupDetail(props: {
  readonly groupID: string
  readonly source: GroupDetailSource
  readonly actor: string
  readonly admin: boolean
}) {
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [employeeID, setEmployeeID] = createSignal("")
  const [ownerEmployeeID, setOwnerEmployeeID] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const group = createQuery(() => ({ queryKey: ["skill-market", "group", props.groupID] as const, queryFn: ({ signal }) => props.source.detail(props.groupID, signal) }))
  const members = createQuery(() => ({ queryKey: ["skill-market", "group", props.groupID, "members"] as const, queryFn: ({ signal }) => props.source.members(props.groupID, signal) }))
  const canManage = () => props.admin || group.data?.ownerEmployeeID === props.actor
  const run = (request: Promise<unknown>, refreshMembers = false) => {
    if (pending()) return
    setPending(true)
    setError(undefined)
    void request
      .then(() => Promise.all([group.refetch(), ...(refreshMembers ? [members.refetch()] : [])]))
      .catch(() => setError("小组操作失败，状态可能已更新，请刷新后重试。"))
      .finally(() => setPending(false))
  }

  return (
    <Switch>
      <Match when={group.isPending}><main class="submission-page"><section class="submission-state" role="status">正在加载小组…</section></main></Match>
      <Match when={group.error}><main class="submission-page"><section class="submission-state" role="alert">小组不存在或无权访问。</section></main></Match>
      <Match when={group.data}>
        {(record) => (
          <main class="submission-page group-detail">
            <header class="submission-page__heading">
              <div><p class="submission-page__eyebrow">Sharing group</p><h1>{record().name}</h1><p>{record().description ?? "暂无说明"}</p></div>
              <span class="group-status">{record().status === "active" ? "启用" : "已停用"}</span>
            </header>
            <Show when={error()}>{(message) => <p class="submission-form__errors" role="alert">{message()}</p>}</Show>
            <section class="submission-detail__section">
              <h2>成员</h2>
              <Show when={members.data} fallback={<p role="status">正在加载成员…</p>}>
                <ul class="group-member-list">
                  <For each={members.data}>
                    {(member) => (
                      <li><span><strong>{member.employeeID}</strong><small>{member.employeeID === record().ownerEmployeeID ? "负责人" : "成员"}</small></span>
                        <Show when={canManage() && member.employeeID !== record().ownerEmployeeID}>
                          <button type="button" disabled={pending()} onClick={() => run(props.source.removeMember(record().id, member.employeeID, { expectedVersion: record().version }), true)}>移除 {member.employeeID}</button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
            <Show when={canManage()}>
              <section class="group-management" aria-label="小组管理操作">
                <form onSubmit={(event) => { event.preventDefault(); if (employeeID().trim()) run(props.source.addMember(record().id, { expectedVersion: record().version, employeeID: employeeID().trim() }), true) }}>
                  <label><span>待添加员工工号</span><input aria-label="待添加员工工号" value={employeeID()} onInput={(event) => setEmployeeID(event.currentTarget.value)} /></label>
                  <button type="submit" class="market-primary-action" disabled={pending() || !employeeID().trim()}>添加成员</button>
                </form>
                <form onSubmit={(event) => { event.preventDefault(); run(props.source.update(record().id, { expectedVersion: record().version, ...(name().trim() ? { name: name().trim() } : {}), ...(description().trim() ? { description: description().trim() } : {}) })) }}>
                  <label><span>新名称</span><input aria-label="新名称" value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label>
                  <label><span>新说明</span><input aria-label="新说明" value={description()} onInput={(event) => setDescription(event.currentTarget.value)} /></label>
                  <button type="submit" disabled={pending() || (!name().trim() && !description().trim())}>保存资料</button>
                </form>
                <form onSubmit={(event) => { event.preventDefault(); if (ownerEmployeeID().trim()) run(props.source.transfer(record().id, { expectedVersion: record().version, ownerEmployeeID: ownerEmployeeID().trim() }), true) }}>
                  <label><span>新负责人工号</span><input aria-label="新负责人工号" value={ownerEmployeeID()} onInput={(event) => setOwnerEmployeeID(event.currentTarget.value)} /></label>
                  <button type="submit" disabled={pending() || !ownerEmployeeID().trim()}>转让负责人</button>
                </form>
                <button type="button" class="group-danger-action" disabled={pending()} onClick={() => run(props.source.setStatus(record().id, { expectedVersion: record().version, status: record().status === "active" ? "disabled" : "active" }))}>
                  {record().status === "active" ? "停用小组" : "恢复小组"}
                </button>
              </section>
            </Show>
          </main>
        )}
      </Match>
    </Switch>
  )
}
