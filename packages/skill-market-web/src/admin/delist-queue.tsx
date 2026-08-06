import { A, useSearchParams } from "@solidjs/router"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { Match, Show, Switch, For, createSignal } from "solid-js"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"

export type DelistQueueSource = Pick<
  SkillMarketControlDataSource["moderation"],
  "listDelist" | "approveDelist" | "rejectDelist"
>

export function DelistQueue(props: { source: DelistQueueSource }) {
  const [params] = useSearchParams()
  const page = () => {
    const parsed = Number(params.page)
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
  }
  const delist = createQuery(() => ({
    queryKey: ["skill-market", "moderation", "delist-queue", page()] as const,
    queryFn: ({ signal }) => props.source.listDelist({ page: page(), limit: 30 }, signal),
  }))

  return (
    <main class="submission-page moderation-page">
      <header class="submission-page__heading">
        <h1 class="type-page-title">下架审核</h1>
        <p class="type-secondary">所有待处理的下架申请</p>
      </header>
      <Switch>
        <Match when={delist.isPending}>
          <section class="submission-state" role="status">
            正在加载下架审核列表…
          </section>
        </Match>
        <Match when={delist.error}>
          <section class="submission-state" role="alert">
            <h1 class="type-page-title">列表加载失败</h1>
            <p class="type-body">请检查网络后重试。</p>
            <button type="button" onClick={() => void delist.refetch()}>重新加载</button>
          </section>
        </Match>
        <Match when={delist.data}>
          {(result) => (
            <Show
              when={result().items.length > 0}
              fallback={
                <section class="submission-detail__section">
                  <p class="type-body">当前没有待处理的下架申请。</p>
                </section>
              }
            >
              <div class="moderation-table-wrapper">
                <table class="moderation-table">
                  <thead>
                    <tr>
                      <th scope="col">投稿</th>
                      <th scope="col">申请人</th>
                      <th scope="col">下架原因</th>
                      <th scope="col">申请时间</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={result().items}>
                      {(request) => (
                        <DelistQueueRow request={request} source={props.source} />
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <DelistPagination current={result().page} total={result().total} limit={result().limit} />
            </Show>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function DelistQueueRow(props: { request: SkillMarketControl.DelistRequest; source: DelistQueueSource }) {
  const client = useQueryClient()
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [done, setDone] = createSignal(false)

  const invalidate = () =>
    client.invalidateQueries({ queryKey: ["skill-market", "moderation", "delist-queue"] })

  const decide = (kind: "approve" | "reject") => {
    if (pending()) return
    setPending(true)
    setError(undefined)
    const operation =
      kind === "approve"
        ? props.source.approveDelist(props.request.id, { expectedVersion: props.request.version }, crypto.randomUUID())
        : props.source.rejectDelist(props.request.id, { expectedVersion: props.request.version }, crypto.randomUUID())
    void operation
      .then(() => {
        setDone(true)
        void invalidate()
      })
      .catch((cause: unknown) =>
        setError(cause instanceof MarketControlError ? `${cause.message}（请求编号：${cause.requestId}）` : "操作失败，请重试"),
      )
      .finally(() => setPending(false))
  }

  const waitLabel = (createdAt: string) => {
    const diff = Date.now() - Date.parse(createdAt)
    if (diff < 60_000) return "刚刚"
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    return `${Math.floor(diff / 86_400_000)} 天前`
  }

  return (
    <tr>
      <td>
        <A href={`/admin/submissions/${encodeURIComponent(props.request.submissionID)}`}>
          {props.request.submissionID.slice(0, 16)}…
        </A>
      </td>
      <td>
        <span class="type-body">{props.request.requestedByEmployeeID}</span>
      </td>
      <td>
        <span class="type-body">{props.request.reason}</span>
      </td>
      <td>
        <span class="type-body">{waitLabel(props.request.createdAt)}</span>
      </td>
      <td>
        <Show
          when={done()}
          fallback={
            <div class="delist-row-actions">
              <button
                type="button"
                class="market-primary-action"
                disabled={pending()}
                onClick={() => decide("approve")}
              >
                批准
              </button>
              <button
                type="button"
                class="admin-danger-action"
                disabled={pending()}
                onClick={() => decide("reject")}
              >
                拒绝
              </button>
              <Show when={error()}>
                {(message) => <span class="delist-row-error" role="alert">{message()}</span>}
              </Show>
            </div>
          }
        >
          <span class="type-secondary">已处理</span>
        </Show>
      </td>
    </tr>
  )
}

function DelistPagination(props: { current: number; total: number; limit: number }) {
  const pages = () => Math.max(1, Math.ceil(props.total / props.limit))
  const pageUrl = (page: number) => `/admin/delist-review?page=${page}`
  return (
    <nav class="submission-pagination" aria-label="下架审核分页">
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
