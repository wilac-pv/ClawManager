import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { A, useSearchParams } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Match, Show, Switch } from "solid-js"
import type { SkillMarketControlDataSource } from "../control-data-source"

export type AuditLogSource = Pick<SkillMarketControlDataSource["audit"], "list">

interface AuditLogProps {
  readonly source: AuditLogSource
}

const actions: SkillMarketControl.AuditAction[] = [
  "bootstrap-admin",
  "role-assigned",
  "role-removed",
  "submission-created",
  "revision-uploaded",
  "validation-succeeded",
  "validation-failed",
  "review-approved",
  "review-changes-requested",
  "review-rejected",
  "publish-started",
  "publish-succeeded",
  "publish-failed",
  "publish-retried",
  "community-delisted",
  "community-restored",
  "user-disabled",
  "user-enabled",
]
const objectTypes: SkillMarketControl.AuditObjectType[] = [
  "user",
  "role",
  "submission",
  "revision",
  "publish_job",
  "community_skill",
]

export function AuditLog(props: AuditLogProps) {
  const [params, setParams] = useSearchParams()
  const actor = () => textParam(params.actor)
  const action = () => actions.find((value) => value === params.action)
  const objectType = () => objectTypes.find((value) => value === params.objectType)
  const objectID = () => textParam(params.objectID)
  const createdFrom = () => dateParam(params.createdFrom, false)
  const createdTo = () => dateParam(params.createdTo, true)
  const page = () => pageParam(params.page)
  const events = createQuery(() => ({
    queryKey: [
      "skill-market",
      "audit",
      actor(),
      action(),
      objectType(),
      objectID(),
      createdFrom(),
      createdTo(),
      page(),
    ] as const,
    queryFn: ({ signal }) =>
      props.source.list(
        {
          actor: actor(),
          action: action(),
          objectType: objectType(),
          objectID: objectID(),
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
    <main class="submission-page audit-page">
      <header class="submission-page__heading">
        <div>
          <p class="submission-page__eyebrow">Admin workspace</p>
          <h1>审计日志</h1>
          <p>只读查看角色、审核、发布和市场运营操作。</p>
        </div>
      </header>

      <section class="moderation-filters audit-filters" aria-label="审计筛选">
        <label>
          <span>操作人工号</span>
          <input
            aria-label="操作人工号"
            value={actor() ?? ""}
            onChange={(event) => update({ actor: event.currentTarget.value.trim() || undefined })}
          />
        </label>
        <label>
          <span>操作类型</span>
          <select
            aria-label="操作类型"
            value={action() ?? ""}
            onChange={(event) => update({ action: event.currentTarget.value || undefined })}
          >
            <option value="">全部操作</option>
            <For each={actions}>{(value) => <option value={value}>{actionLabel(value)}</option>}</For>
          </select>
        </label>
        <label>
          <span>对象类型</span>
          <select
            aria-label="对象类型"
            value={objectType() ?? ""}
            onChange={(event) => update({ objectType: event.currentTarget.value || undefined })}
          >
            <option value="">全部对象</option>
            <For each={objectTypes}>{(value) => <option value={value}>{objectTypeLabel(value)}</option>}</For>
          </select>
        </label>
        <label>
          <span>对象 ID</span>
          <input
            aria-label="对象 ID"
            value={objectID() ?? ""}
            onChange={(event) => update({ objectID: event.currentTarget.value.trim() || undefined })}
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
      </section>

      <Switch>
        <Match when={events.isPending}>
          <section class="submission-state" role="status">
            正在加载审计日志…
          </section>
        </Match>
        <Match when={events.error}>
          <section class="submission-state" role="alert">
            <h2>审计日志加载失败</h2>
            <button type="button" onClick={() => void events.refetch()}>
              重新加载
            </button>
          </section>
        </Match>
        <Match when={events.data}>
          {(result) => (
            <Show
              when={result().items.length > 0}
              fallback={
                <section class="submission-state">
                  <h2>没有匹配的审计事件</h2>
                </section>
              }
            >
              <section class="audit-events" aria-label="审计事件">
                <For each={result().items}>
                  {(event) => (
                    <article class="audit-event">
                      <header>
                        <div>
                          <strong>{actionLabel(event.action)}</strong>
                          <span>
                            {objectTypeLabel(event.objectType)} · {event.objectID}
                          </span>
                        </div>
                        <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                      </header>
                      <dl>
                        <div>
                          <dt>操作人</dt>
                          <dd>{event.actor ? `${event.actor.displayName}（${event.actor.employeeID}）` : "系统"}</dd>
                        </div>
                        <div>
                          <dt>请求编号</dt>
                          <dd>{event.requestID}</dd>
                        </div>
                      </dl>
                      <div class="audit-event__changes">
                        <Show when={event.before !== undefined}>
                          <div>
                            <strong>变更前</strong>
                            <pre>{safeJson(event.before)}</pre>
                          </div>
                        </Show>
                        <Show when={event.after !== undefined}>
                          <div>
                            <strong>变更后</strong>
                            <pre>{safeJson(event.after)}</pre>
                          </div>
                        </Show>
                      </div>
                    </article>
                  )}
                </For>
              </section>
              <AuditPagination current={result().page} total={result().total} limit={result().limit} params={params} />
            </Show>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function AuditPagination(props: {
  current: number
  total: number
  limit: number
  params: Record<string, string | string[] | undefined>
}) {
  const pages = () => Math.max(1, Math.ceil(props.total / props.limit))
  return (
    <nav class="submission-pagination" aria-label="审计分页">
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

function safeJson(value: unknown) {
  return JSON.stringify(redact(value), null, 2)
}

function redact(value: unknown, key = ""): unknown {
  if (/token|secret|password|credential|cookie|authorization|access.?key|private.?key/i.test(key)) return "[REDACTED]"
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]))
}

function pageUrl(params: Record<string, string | string[] | undefined>, page: number) {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (typeof value === "string" && value) query.set(key, value)
  })
  query.set("page", String(page))
  return `/admin/audit?${query}`
}

function textParam(value: string | string[] | undefined) {
  return typeof value === "string" && value ? value : undefined
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

function actionLabel(action: SkillMarketControl.AuditAction) {
  return action
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ")
}

function objectTypeLabel(type: SkillMarketControl.AuditObjectType) {
  return type.replaceAll("_", " ")
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}
