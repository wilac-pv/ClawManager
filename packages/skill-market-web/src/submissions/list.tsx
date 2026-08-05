import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { A, useSearchParams } from "@solidjs/router"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createSignal, onMount } from "solid-js"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"
import { SpacePageHeader } from "../space/page"

export type SubmissionReader = Pick<SkillMarketControlDataSource["submissions"], "list" | "deletePersonal">

interface SubmissionListProps {
  readonly source: SubmissionReader
  readonly target?: SkillMarketControl.PublicationTarget
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
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [deleting, setDeleting] = createSignal<SkillMarketControl.SubmissionSummary>()
  const [deletePending, setDeletePending] = createSignal(false)
  const [deleteError, setDeleteError] = createSignal<string>()
  let deleteTrigger: HTMLButtonElement | undefined
  const status = () => statuses.find((item) => item.value === params.status)?.value
  const page = () => {
    const value = Number(params.page ?? "1")
    if (!Number.isInteger(value) || value < 1) return 1
    return value
  }
  const submissions = createQuery(() => ({
    queryKey: ["skill-market", "submissions", props.target, status(), page()] as const,
    queryFn: ({ signal }) =>
      props.source.list({ target: props.target, status: status(), page: page(), limit: 30 }, signal),
  }))
  const closeDelete = () => {
    if (deletePending()) return
    setDeleting(undefined)
    queueMicrotask(() => deleteTrigger?.focus())
  }
  const confirmDelete = () => {
    const item = deleting()
    if (!item || deletePending()) return
    setDeletePending(true)
    setDeleteError(undefined)
    void props.source
      .deletePersonal(item.id, { expectedVersion: item.version }, createIdempotencyKey())
      .then(() => {
        setDeleting(undefined)
        void client.invalidateQueries({ queryKey: ["skill-market", "submissions"] })
        void client.invalidateQueries({ queryKey: ["skill-market", "personal-trash"] })
        queueMicrotask(() => deleteTrigger?.focus())
      })
      .catch((cause: unknown) =>
        setDeleteError(
          cause instanceof MarketControlError
            ? `${cause.message}（请求编号：${cause.requestId}）`
            : "删除个人 Skill 失败，请检查网络后重试。",
        ),
      )
      .finally(() => setDeletePending(false))
  }

  return (
    <main class="submission-page space-page">
      <SpacePageHeader
        eyebrow={props.target === "personal" ? "Private skills" : "Company publishing"}
        title={props.target === "personal" ? "个人 Skill" : "我的投稿"}
        description={
          props.target === "personal"
            ? "仅你本人可见；安全扫描通过后即可下载使用。"
            : "查看校验、审核和发布进度，或提交新的 Skill 版本。"
        }
        action={
          <A
            class="market-primary-action"
            href={props.target === "personal" ? "/submissions/new?target=personal" : "/submissions/new"}
          >
            {props.target === "personal" ? "上传 Skill" : "投稿 Skill"}
          </A>
        }
      />

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
        <Show when={submissions.data}>
          {(result) => <strong>共 {result().total} 个{props.target === "personal" ? " Skill" : "投稿"}</strong>}
        </Show>
      </section>

      <Switch>
        <Match when={submissions.isPending}>
          <section class="submission-state space-page__state" role="status">
            正在加载投稿…
          </section>
        </Match>
        <Match when={submissions.error}>
          <section class="submission-state space-page__state" role="alert">
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
                <section class="submission-state space-page__state">
                  <h2>{props.target === "personal" ? "个人空间还是空的" : "还没有投稿"}</h2>
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
                            {item.target === "personal" && item.status === "published" ? "可用" : statusLabel(item.status)}
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
                          <A href={`/submissions/new?from=${encodeURIComponent(item.id)}`}>
                            {item.target === "personal" ? "上传新版本" : "提交新版本"}
                          </A>
                        </Show>
                        <Show when={item.status === "validation_failed" || item.status === "changes_requested"}>
                          <A href={`/submissions/${item.id}`}>修改并重试</A>
                        </Show>
                        <Show when={props.target === "personal" && item.status === "published"}>
                          <button
                            type="button"
                            class="admin-danger-action"
                            disabled={deletePending()}
                            ref={(element) => {
                              deleteTrigger = element
                            }}
                            onClick={(event) => {
                              deleteTrigger = event.currentTarget
                              setDeleteError(undefined)
                              setDeleting(item)
                            }}
                          >
                            删除个人 Skill
                          </button>
                        </Show>
                      </div>
                    </article>
                  )}
                </For>
              </section>
              <Pagination
                current={result().page}
                total={result().total}
                limit={result().limit}
                status={status()}
                target={props.target}
              />
            </Show>
          )}
        </Match>
      </Switch>
      <Show when={deleting()}>
        {(item) => <PersonalDeleteConfirmation item={item()} pending={deletePending()} error={deleteError()} onCancel={closeDelete} onConfirm={confirmDelete} />}
      </Show>
    </main>
  )
}

function PersonalDeleteConfirmation(props: {
  item: SkillMarketControl.SubmissionSummary
  pending: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  let cancel: HTMLButtonElement | undefined
  onMount(() => cancel?.focus())
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="personal-delete-title" onKeyDown={(event) => { if (event.key === "Escape") props.onCancel() }}>
      <h2 id="personal-delete-title">删除个人 Skill</h2>
      <p>确认删除 {props.item.skillID} {props.item.targetVersion}？删除后可在回收站恢复。</p>
      <Show when={props.error}>{(message) => <div class="submission-form__errors" role="alert">{message()}</div>}</Show>
      <div>
        <button type="button" disabled={props.pending} ref={(element) => { cancel = element }} onClick={props.onCancel}>取消</button>
        <button type="button" class="admin-danger-action" disabled={props.pending} onClick={props.onConfirm}>{props.pending ? "正在删除…" : "确认删除"}</button>
      </div>
    </div>
  )
}

function Pagination(props: {
  current: number
  total: number
  limit: number
  status?: SkillMarketControl.SubmissionStatus
  target?: SkillMarketControl.PublicationTarget
}) {
  const pages = () => Math.max(1, Math.ceil(props.total / props.limit))
  return (
    <nav class="submission-pagination" aria-label="投稿分页">
      <Show when={props.current > 1} fallback={<span aria-hidden="true" />}>
        <A href={pageUrl(props.current - 1, props.status, props.target)}>上一页</A>
      </Show>
      <span>
        第 {props.current} / {pages()} 页
      </span>
      <Show when={props.current < pages()} fallback={<span aria-hidden="true" />}>
        <A href={pageUrl(props.current + 1, props.status, props.target)}>下一页</A>
      </Show>
    </nav>
  )
}

function pageUrl(
  page: number,
  status?: SkillMarketControl.SubmissionStatus,
  target?: SkillMarketControl.PublicationTarget,
) {
  const query = new URLSearchParams()
  if (status) query.set("status", status)
  query.set("page", String(page))
  return `${target === "personal" ? "/personal" : "/submissions"}?${query}`
}

function statusLabel(status: SkillMarketControl.SubmissionStatus) {
  return statuses.find((item) => item.value === status)?.label ?? status
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}

function createIdempotencyKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
