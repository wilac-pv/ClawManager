import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { A, useSearchParams } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Match, Show, Switch } from "solid-js"
import type { SkillMarketControlDataSource } from "../control-data-source"

export type SubmissionReader = Pick<SkillMarketControlDataSource["submissions"], "list">

interface SubmissionListProps {
  readonly source: SubmissionReader
}

const statuses: ReadonlyArray<{ value: SkillMarketControl.SubmissionStatus; label: string }> = [
  { value: "validating", label: "校验中" },
  { value: "validation_failed", label: "校验失败" },
  { value: "pending_review", label: "待审核" },
  { value: "changes_requested", label: "需修改" },
  { value: "rejected", label: "已拒绝" },
  { value: "publishing", label: "发布中" },
  { value: "publish_failed", label: "发布失败" },
  { value: "published", label: "已发布" },
]

export function SubmissionList(props: SubmissionListProps) {
  const [params, setParams] = useSearchParams()
  const status = () => statuses.find((item) => item.value === params.status)?.value
  const page = () => {
    const value = Number(params.page ?? "1")
    if (!Number.isInteger(value) || value < 1) return 1
    return value
  }
  const submissions = createQuery(() => ({
    queryKey: ["skill-market", "submissions", status(), page()] as const,
    queryFn: ({ signal }) => props.source.list({ status: status(), page: page(), limit: 30 }, signal),
  }))

  return (
    <main class="submission-page">
      <header class="submission-page__heading">
        <div>
          <p class="submission-page__eyebrow">投稿工作台</p>
          <h1>我的投稿</h1>
          <p>查看校验、审核和发布进度，或提交新的 Skill 版本。</p>
        </div>
        <A class="market-primary-action submission-page__create" href="/submissions/new">
          投稿 Skill
        </A>
      </header>

      <section class="submission-toolbar" aria-label="投稿筛选">
        <label>
          <span>投稿状态</span>
          <select
            value={status() ?? ""}
            onChange={(event) =>
              setParams({ status: event.currentTarget.value || undefined, page: undefined }, { replace: true })
            }
          >
            <option value="">全部状态</option>
            <For each={statuses}>{(item) => <option value={item.value}>{item.label}</option>}</For>
          </select>
        </label>
        <Show when={submissions.data}>{(result) => <strong>共 {result().total} 个投稿</strong>}</Show>
      </section>

      <Switch>
        <Match when={submissions.isPending}>
          <section class="submission-state" role="status">
            正在加载投稿…
          </section>
        </Match>
        <Match when={submissions.error}>
          <section class="submission-state" role="alert">
            <h2>投稿加载失败</h2>
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
                  <h2>还没有投稿</h2>
                  <p>准备好 ZIP 包后即可提交第一个 Skill。</p>
                </section>
              }
            >
              <section class="submission-list" aria-label="我的投稿列表">
                <For each={result().items}>
                  {(item) => (
                    <article class="submission-card">
                      <div class="submission-card__main">
                        <div class="submission-card__title">
                          <h2>
                            <A href={`/submissions/${item.id}`}>{item.skillID}</A>
                          </h2>
                          <span class={`submission-status submission-status--${item.status}`}>
                            {statusLabel(item.status)}
                          </span>
                        </div>
                        <p>
                          目标版本 {item.targetVersion} · 修订 {item.currentRevision}
                        </p>
                        <small>更新于 {formatDate(item.updatedAt)}</small>
                      </div>
                      <div class="submission-card__actions">
                        <A href={`/submissions/${item.id}`}>查看详情</A>
                        <Show when={item.status === "published"}>
                          <A href={`/submissions/new?from=${encodeURIComponent(item.id)}`}>提交新版本</A>
                        </Show>
                        <Show when={item.status === "validation_failed" || item.status === "changes_requested"}>
                          <A href={`/submissions/${item.id}`}>修改并重试</A>
                        </Show>
                      </div>
                    </article>
                  )}
                </For>
              </section>
              <Pagination current={result().page} total={result().total} limit={result().limit} status={status()} />
            </Show>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function Pagination(props: {
  current: number
  total: number
  limit: number
  status?: SkillMarketControl.SubmissionStatus
}) {
  const pages = () => Math.max(1, Math.ceil(props.total / props.limit))
  return (
    <nav class="submission-pagination" aria-label="投稿分页">
      <Show when={props.current > 1} fallback={<span aria-hidden="true" />}>
        <A href={pageUrl(props.current - 1, props.status)}>上一页</A>
      </Show>
      <span>
        第 {props.current} / {pages()} 页
      </span>
      <Show when={props.current < pages()} fallback={<span aria-hidden="true" />}>
        <A href={pageUrl(props.current + 1, props.status)}>下一页</A>
      </Show>
    </nav>
  )
}

function pageUrl(page: number, status?: SkillMarketControl.SubmissionStatus) {
  const query = new URLSearchParams()
  if (status) query.set("status", status)
  query.set("page", String(page))
  return `/submissions?${query}`
}

function statusLabel(status: SkillMarketControl.SubmissionStatus) {
  return statuses.find((item) => item.value === status)?.label ?? status
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}
