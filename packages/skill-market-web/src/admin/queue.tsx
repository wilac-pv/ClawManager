import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { A, useSearchParams } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Match, Show, Switch } from "solid-js"
import type { SkillMarketControlDataSource } from "../control-data-source"
import { statusLabel } from "../submissions/status"

export type ModerationQueueSource = Pick<SkillMarketControlDataSource["moderation"], "list">

interface ModerationQueueProps {
  readonly source: ModerationQueueSource
  readonly now?: () => number
}

const statuses: SkillMarketControl.SubmissionStatus[] = [
  "validating",
  "validation_failed",
  "pending_review",
  "changes_requested",
  "rejected",
  "publishing",
  "publish_failed",
  "published",
]
const risks = ["unknown", "safe", "warning", "danger"] as const

export function ModerationQueue(props: ModerationQueueProps) {
  const [params, setParams] = useSearchParams()
  const status = () => statuses.find((value) => value === params.status)
  const risk = () => risks.find((value) => value === params.risk)
  const submitter = () => (typeof params.submitter === "string" && params.submitter ? params.submitter : undefined)
  const createdFrom = () => dateParam(params.createdFrom, false)
  const createdTo = () => dateParam(params.createdTo, true)
  const page = () => pageParam(params.page)
  const submissions = createQuery(() => ({
    queryKey: [
      "skill-market",
      "moderation",
      status(),
      risk(),
      submitter(),
      createdFrom(),
      createdTo(),
      page(),
    ] as const,
    queryFn: ({ signal }) =>
      props.source.list(
        {
          status: status(),
          risk: risk(),
          submitter: submitter(),
          createdFrom: createdFrom(),
          createdTo: createdTo(),
          page: page(),
          limit: 30,
        },
        signal,
      ),
  }))
  const update = (values: Record<string, string | undefined>) =>
    setParams({ ...values, page: undefined }, { replace: true })

  return (
    <main class="submission-page moderation-page">
      <header class="submission-page__heading">
        <div>
          <p class="submission-page__eyebrow">Reviewer workspace</p>
          <h1>审核队列</h1>
          <p>按等待顺序处理投稿，重点检查安全扫描与变更内容。</p>
        </div>
      </header>

      <section class="moderation-filters" aria-label="审核队列筛选">
        <label>
          <span>投稿状态</span>
          <select
            aria-label="投稿状态"
            value={status() ?? ""}
            onChange={(event) => update({ status: event.currentTarget.value || undefined })}
          >
            <option value="">全部状态</option>
            <For each={statuses}>{(value) => <option value={value}>{statusLabel(value)}</option>}</For>
          </select>
        </label>
        <label>
          <span>风险等级</span>
          <select
            aria-label="风险等级"
            value={risk() ?? ""}
            onChange={(event) => update({ risk: event.currentTarget.value || undefined })}
          >
            <option value="">全部风险</option>
            <For each={risks}>{(value) => <option value={value}>{riskLabel(value)}</option>}</For>
          </select>
        </label>
        <label>
          <span>投稿人工号</span>
          <input
            aria-label="投稿人工号"
            value={submitter() ?? ""}
            onChange={(event) => update({ submitter: event.currentTarget.value.trim() || undefined })}
          />
        </label>
        <label>
          <span>开始日期</span>
          <input
            aria-label="开始日期"
            type="date"
            value={typeof params.createdFrom === "string" ? params.createdFrom : ""}
            onChange={(event) => update({ createdFrom: event.currentTarget.value || undefined })}
          />
        </label>
        <label>
          <span>结束日期</span>
          <input
            aria-label="结束日期"
            type="date"
            value={typeof params.createdTo === "string" ? params.createdTo : ""}
            onChange={(event) => update({ createdTo: event.currentTarget.value || undefined })}
          />
        </label>
        <Show when={submissions.data}>{(result) => <strong>共 {result().total} 个投稿</strong>}</Show>
      </section>

      <Switch>
        <Match when={submissions.isPending}>
          <section class="submission-state" role="status">
            正在加载审核队列…
          </section>
        </Match>
        <Match when={submissions.error}>
          <section class="submission-state" role="alert">
            <h2>审核队列加载失败</h2>
            <p>请检查网络后重试。</p>
            <button type="button" onClick={() => void submissions.refetch()}>
              重新加载
            </button>
          </section>
        </Match>
        <Match when={submissions.data}>
          {(result) => (
            <Show
              when={result().items.length > 0}
              fallback={
                <section class="submission-state">
                  <h2>没有匹配的投稿</h2>
                  <p>可以调整筛选条件查看其他投稿。</p>
                </section>
              }
            >
              <div class="moderation-table-wrap">
                <table class="moderation-table">
                  <thead>
                    <tr>
                      <th>Skill</th>
                      <th>投稿人</th>
                      <th>状态</th>
                      <th>风险</th>
                      <th>等待时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={result().items}>
                      {(item) => (
                        <tr>
                          <td>
                            <strong>{item.skillID}</strong>
                            <small>{item.targetVersion}</small>
                          </td>
                          <td>
                            <strong>{item.owner.displayName}</strong>
                            <small>{item.owner.employeeID}</small>
                          </td>
                          <td>
                            <span class={`submission-status submission-status--${item.status}`}>
                              {statusLabel(item.status)}
                            </span>
                          </td>
                          <td>
                            <span class={`moderation-risk moderation-risk--${item.risk}`}>{riskLabel(item.risk)}</span>
                          </td>
                          <td>{waitLabel(item.createdAt, (props.now ?? Date.now)())}</td>
                          <td>
                            <A href={`/admin/submissions/${item.id}`} aria-label={`审核 ${item.skillID}`}>
                              查看审核
                            </A>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <QueuePagination current={result().page} total={result().total} limit={result().limit} params={params} />
            </Show>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function QueuePagination(props: {
  current: number
  total: number
  limit: number
  params: Record<string, string | string[] | undefined>
}) {
  const pages = () => Math.max(1, Math.ceil(props.total / props.limit))
  return (
    <nav class="submission-pagination" aria-label="审核队列分页">
      <Show when={props.current > 1} fallback={<span aria-hidden="true" />}>
        <A href={pageUrl(props.params, props.current - 1)}>上一页</A>
      </Show>
      <span>
        第 {props.current} / {pages()} 页
      </span>
      <Show when={props.current < pages()} fallback={<span aria-hidden="true" />}>
        <A href={pageUrl(props.params, props.current + 1)}>下一页</A>
      </Show>
    </nav>
  )
}

function pageUrl(params: Record<string, string | string[] | undefined>, page: number) {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (typeof value === "string" && value) query.set(key, value)
  })
  query.set("page", String(page))
  return `/admin?${query}`
}

function pageParam(value: string | string[] | undefined) {
  const parsed = typeof value === "string" ? Number(value) : 1
  if (!Number.isInteger(parsed) || parsed < 1) return 1
  return parsed
}

function dateParam(value: string | string[] | undefined, end: boolean) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  return `${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`
}

function riskLabel(risk: SkillMarketControl.SubmissionSummary["risk"]) {
  if (risk === "safe") return "安全"
  if (risk === "warning") return "警告"
  if (risk === "danger") return "危险"
  return "未知"
}

function waitLabel(createdAt: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60_000))
  if (minutes < 60) return `已等待 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `已等待 ${hours} 小时`
  return `已等待 ${Math.floor(hours / 24)} 天`
}
