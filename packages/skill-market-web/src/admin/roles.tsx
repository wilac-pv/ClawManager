import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createSignal } from "solid-js"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"

export type RoleAdministrationSource = Pick<SkillMarketControlDataSource["roles"], "list" | "assign" | "remove">

interface RoleAdministrationProps {
  readonly source: RoleAdministrationSource
}

export function RoleAdministration(props: RoleAdministrationProps) {
  const client = useQueryClient()
  const [employeeID, setEmployeeID] = createSignal("")
  const [role, setRole] = createSignal<SkillMarketControl.Role>("reviewer")
  const [confirmation, setConfirmation] = createSignal<{
    employeeID: string
    role: SkillMarketControl.Role
  }>()
  const [error, setError] = createSignal<string>()
  const [pending, setPending] = createSignal(false)
  const assignments = createQuery(() => ({
    queryKey: ["skill-market", "roles"] as const,
    queryFn: ({ signal }) => props.source.list(signal),
  }))
  const assign = (event: SubmitEvent) => {
    event.preventDefault()
    const target = employeeID().trim()
    if (!target || pending()) return
    setPending(true)
    setError(undefined)
    void props.source
      .assign({ employeeID: target, role: role() })
      .then((result) => {
        client.setQueryData<ReadonlyArray<SkillMarketControl.RoleAssignment>>(
          ["skill-market", "roles"],
          (current = []) => [...current, result],
        )
        setEmployeeID("")
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setPending(false))
  }
  const remove = () => {
    const target = confirmation()
    if (!target || pending()) return
    setPending(true)
    setError(undefined)
    void props.source
      .remove(target.employeeID, target.role)
      .then((result) => {
        client.setQueryData(["skill-market", "roles"], result)
        setConfirmation(undefined)
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setPending(false))
  }

  return (
    <main class="submission-page admin-roles">
      <header class="submission-page__heading">
        <div>
          <p class="submission-page__eyebrow">Admin workspace</p>
          <h1>角色管理</h1>
          <p>Reviewer 可以审核投稿；Admin 还可以管理角色、审计和市场运营。</p>
        </div>
      </header>

      <form class="admin-role-form" onSubmit={assign} onInput={() => setError(undefined)}>
        <label>
          <span>员工工号</span>
          <input
            aria-label="员工工号"
            value={employeeID()}
            onInput={(event) => setEmployeeID(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>角色</span>
          <select
            aria-label="角色"
            value={role()}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === "reviewer" || value === "admin") setRole(value)
            }}
          >
            <option value="reviewer">Reviewer</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button type="submit" class="market-primary-action" disabled={pending() || !employeeID().trim()}>
          {pending() ? "正在处理…" : "添加角色"}
        </button>
      </form>

      <Show when={error()}>
        {(message) => (
          <div class="submission-form__errors admin-role-error" role="alert">
            {message()}
          </div>
        )}
      </Show>

      <Show when={confirmation()}>
        {(target) => (
          <section class="admin-role-confirmation" aria-label="移除角色确认">
            <p>
              确认移除 {target().employeeID} 的 {roleLabel(target().role)}？
            </p>
            <div>
              <button type="button" onClick={() => setConfirmation(undefined)}>
                取消
              </button>
              <button type="button" class="market-primary-action" disabled={pending()} onClick={remove}>
                确认移除
              </button>
            </div>
          </section>
        )}
      </Show>

      <Switch>
        <Match when={assignments.isPending}>
          <section class="submission-state" role="status">
            正在加载角色…
          </section>
        </Match>
        <Match when={assignments.error}>
          <section class="submission-state" role="alert">
            <h2>角色加载失败</h2>
            <button type="button" onClick={() => void assignments.refetch()}>
              重新加载
            </button>
          </section>
        </Match>
        <Match when={assignments.data}>
          {(items) => (
            <div class="moderation-table-wrap">
              <table class="moderation-table">
                <thead>
                  <tr>
                    <th>员工</th>
                    <th>角色</th>
                    <th>添加人</th>
                    <th>添加时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={items()}>
                    {(item) => (
                      <tr>
                        <td>
                          <strong>{item.user.displayName}</strong>
                          <small>{item.user.employeeID}</small>
                          <Show when={item.user.disabledAt}>
                            <span class="admin-disabled-user">账号已禁用</span>
                          </Show>
                        </td>
                        <td>{roleLabel(item.role)}</td>
                        <td>{item.createdBy}</td>
                        <td>{formatDate(item.createdAt)}</td>
                        <td>
                          <button
                            type="button"
                            class="admin-link-button"
                            aria-label={`移除 ${item.user.employeeID} 的 ${roleLabel(item.role)}`}
                            onClick={() => {
                              setError(undefined)
                              setConfirmation({ employeeID: item.user.employeeID, role: item.role })
                            }}
                          >
                            移除
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function errorMessage(cause: unknown) {
  if (cause instanceof MarketControlError) return `${cause.message}（请求编号：${cause.requestId}）`
  return "角色操作失败，请检查网络后重试。"
}

function roleLabel(role: SkillMarketControl.Role) {
  return role === "admin" ? "Admin" : "Reviewer"
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}
