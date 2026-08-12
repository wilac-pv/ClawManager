import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { A } from "@solidjs/router"
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
  const [editMode, setEditMode] = createSignal(false)
  const [editName, setEditName] = createSignal("")
  const [editDesc, setEditDesc] = createSignal("")
  const [memberInput, setMemberInput] = createSignal("")
  const [transferInput, setTransferInput] = createSignal("")
  const [pendingAction, setPendingAction] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const group = createQuery(() => ({ queryKey: ["skill-market", "group", props.groupID] as const, queryFn: ({ signal }) => props.source.detail(props.groupID, signal) }))
  const members = createQuery(() => ({ queryKey: ["skill-market", "group", props.groupID, "members"] as const, queryFn: ({ signal }) => props.source.members(props.groupID, signal) }))
  const canManage = () => props.admin || group.data?.ownerEmployeeID === props.actor

  const run = (action: string, request: Promise<unknown>, refreshMembers = false, onSuccess?: () => void) => {
    if (pendingAction()) return
    setPendingAction(action)
    setError(undefined)
    void request
      .then(() => {
        void group.refetch()
        if (refreshMembers) void members.refetch()
        onSuccess?.()
      })
      .catch(() => setError("操作失败，状态可能已更新，请刷新后重试。"))
      .finally(() => setPendingAction(undefined))
  }

  const startEdit = () => {
    setEditName(group.data?.name ?? "")
    setEditDesc(group.data?.description ?? "")
    setEditMode(true)
  }

  const saveEdit = (event: SubmitEvent) => {
    event.preventDefault()
    const record = group.data
    if (!record) return
    run("edit", props.source.update(record.id, {
      expectedVersion: record.version,
      ...(editName().trim() ? { name: editName().trim() } : {}),
      ...(editDesc().trim() ? { description: editDesc().trim() } : {}),
    }), false, () => setEditMode(false))
  }

  const addMember = (event: SubmitEvent) => {
    event.preventDefault()
    const record = group.data
    if (!record || !memberInput().trim()) return
    run("add", props.source.addMember(record.id, { expectedVersion: record.version, employeeID: memberInput().trim() }), true, () => setMemberInput(""))
  }

  const removeMember = (employeeID: string) => {
    const record = group.data
    if (!record) return
    if (!window.confirm(`确定移除成员 ${employeeID}？`)) return
    run("remove", props.source.removeMember(record.id, employeeID, { expectedVersion: record.version }), true)
  }

  const transfer = (event: SubmitEvent) => {
    event.preventDefault()
    const record = group.data
    if (!record || !transferInput().trim()) return
    if (!window.confirm(`确定将小组转让给 ${transferInput().trim()}？此操作不可撤销。`)) return
    run("transfer", props.source.transfer(record.id, { expectedVersion: record.version, ownerEmployeeID: transferInput().trim() }), true, () => setTransferInput(""))
  }

  const toggleStatus = () => {
    const record = group.data
    if (!record) return
    const next = record.status === "active" ? "停用" : "恢复"
    if (!window.confirm(`确定${next}小组「${record.name}」？`)) return
    run("status", props.source.setStatus(record.id, { expectedVersion: record.version, status: record.status === "active" ? "disabled" : "active" }))
  }

  return (
    <Switch>
      <Match when={group.isPending}><main class="submission-page"><section class="submission-state" role="status">正在加载小组…</section></main></Match>
      <Match when={group.error}><main class="submission-page"><section class="submission-state" role="alert">小组不存在或无权访问。</section></main></Match>
      <Match when={group.data}>
        {(record) => (
          <main class="submission-page group-detail">
            <div class="group-detail__breadcrumb">
              <A href="/groups">← 我的小组</A>
            </div>
            <header class="group-detail__header">
              <Show
                when={!editMode()}
                fallback={
                  <form class="group-inline-edit" onSubmit={saveEdit}>
                    <input value={editName()} onInput={(e) => setEditName(e.currentTarget.value)} placeholder="小组名称" />
                    <input value={editDesc()} onInput={(e) => setEditDesc(e.currentTarget.value)} placeholder="小组说明" />
                    <button type="submit" class="market-primary-action" disabled={pendingAction() === "edit"}>保存</button>
                    <button type="button" onClick={() => setEditMode(false)}>取消</button>
                  </form>
                }
              >
                <div class="group-detail__title-row">
                  <h1 class="type-page-title">{record().name}</h1>
                  <span classList={{ "group-status": true, "group-status--disabled": record().status !== "active" }}>
                    {record().status === "active" ? "启用" : "已停用"}
                  </span>
                </div>
                <p class="type-secondary">{record().description ?? "暂无说明"}</p>
                <Show when={canManage()}>
                  <div class="group-detail__actions">
                    <button type="button" onClick={startEdit}>编辑</button>
                  </div>
                </Show>
              </Show>
            </header>

            <Show when={error()}>{(message) => <p class="submission-form__errors" role="alert">{message()}</p>}</Show>

            <section class="submission-detail__section">
              <div class="submission-detail__section-heading">
                <h2>成员</h2>
                <Show when={canManage()}>
                  <form class="group-add-member" onSubmit={addMember}>
                    <input value={memberInput()} onInput={(e) => setMemberInput(e.currentTarget.value)} placeholder="输入员工工号" />
                    <button type="submit" disabled={pendingAction() === "add" || !memberInput().trim()}>添加</button>
                  </form>
                </Show>
              </div>
              <Show when={members.data} fallback={<p role="status">正在加载成员…</p>}>
                <ul class="group-member-list">
                  <For each={members.data}>
                    {(member) => (
                      <li class="group-member">
                        <span class="group-member__avatar">{member.employeeID.charAt(0).toUpperCase()}</span>
                        <div class="group-member__info">
                          <strong>{member.employeeID}</strong>
                          <span classList={{ "group-member__role": true, "group-member__role--owner": member.employeeID === record().ownerEmployeeID }}>
                            {member.employeeID === record().ownerEmployeeID ? "负责人" : "成员"}
                          </span>
                        </div>
                        <Show when={canManage() && member.employeeID !== record().ownerEmployeeID}>
                          <button
                            type="button"
                            class="group-member__remove"
                            disabled={pendingAction() === "remove"}
                            onClick={() => removeMember(member.employeeID)}
                          >
                            移除
                          </button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>

            <Show when={canManage()}>
              <section class="submission-detail__section group-detail__danger-zone">
                <h2>管理操作</h2>
                <div class="group-detail__danger-actions">
                  <form class="group-transfer-form" onSubmit={transfer}>
                    <input value={transferInput()} onInput={(e) => setTransferInput(e.currentTarget.value)} placeholder="新负责人工号" />
                    <button type="submit" class="admin-danger-action" disabled={pendingAction() === "transfer" || !transferInput().trim()}>
                      {pendingAction() === "transfer" ? "转让中…" : "转让负责人"}
                    </button>
                  </form>
                  <button
                    type="button"
                    class="group-danger-action"
                    disabled={pendingAction() === "status"}
                    onClick={toggleStatus}
                  >
                    {pendingAction() === "status" ? "处理中…" : record().status === "active" ? "停用小组" : "恢复小组"}
                  </button>
                </div>
              </section>
            </Show>
          </main>
        )}
      </Match>
    </Switch>
  )
}
