import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { A, useSearchParams } from "@solidjs/router"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createSignal } from "solid-js"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"
import { SubmissionForm } from "./form"
import { SubmissionStatusTimeline, submissionPollInterval } from "./status"

export type SubmissionDetailSource = Pick<
  SkillMarketControlDataSource["submissions"],
  "detail" | "create" | "packageUrl" | "revise" | "promote" | "withdraw" | "requestDelist"
>

interface SubmissionDetailProps {
  readonly submissionID: string
  readonly source: SubmissionDetailSource
  readonly groups?: Pick<SkillMarketControlDataSource["groups"], "list">
  readonly department?: SkillMarketControl.Department
}

export function SubmissionDetail(props: SubmissionDetailProps) {
  const [params, setParams] = useSearchParams()
  const [requestCount, setRequestCount] = createSignal(0)
  const submission = createQuery(() => ({
    queryKey: ["skill-market", "submission", props.submissionID] as const,
    queryFn: ({ signal }) => {
      setRequestCount((count) => count + 1)
      return props.source.detail(props.submissionID, signal)
    },
    refetchInterval: (query) => submissionPollInterval(query.state.data?.status, requestCount()),
  }))
  const revise = () =>
    params.revise === "1" &&
    (submission.data?.status === "validation_failed" || submission.data?.status === "changes_requested")

  return (
    <Switch>
      <Match when={submission.isPending}>
        <main class="submission-page">
          <section class="submission-state" role="status">
            正在加载投稿详情…
          </section>
        </main>
      </Match>
      <Match when={submission.error}>
        <main class="submission-page">
          <section class="submission-state" role="alert">
            <h1 class="type-page-title">投稿详情加载失败</h1>
            <p class="type-body">请检查网络后重试。</p>
            <button type="button" onClick={() => void submission.refetch()}>
              重新加载
            </button>
          </section>
        </main>
      </Match>
      <Match when={submission.data}>
        {(detail) => (
          <Show
            when={!revise()}
            fallback={
              <SubmissionForm
                source={props.source}
                mode={{
                  kind: "revision",
                  submissionID: detail().id,
                  expectedVersion: detail().version,
                  initial: detail().metadata,
                  target: detail().target,
                  audience: detail().audience,
                }}
                onAccepted={() => {
                  setParams({ revise: undefined }, { replace: true })
                  void submission.refetch()
                }}
                onConflict={() => void submission.refetch()}
              />
            }
          >
            <main class="submission-page submission-detail">
              <header class="submission-detail__header">
                <div>
                  <A href={detail().target === "personal" ? "/personal" : "/submissions"}>
                    ← 返回{detail().target === "personal" ? "个人空间" : "我的投稿"}
                  </A>
                  <h1 class="type-page-title">{detail().metadata.displayName}</h1>
                  <p class="type-secondary">
                    {detail().skillID} · 目标版本 {detail().targetVersion}
                  </p>
                </div>
                <SubmissionActions
                  detail={detail()}
                  packageUrl={props.source.packageUrl(detail().id)}
                  source={props.source}
                  groups={props.groups}
                  department={props.department}
                  onPromoted={() => void submission.refetch()}
                />
              </header>

              <SubmissionStatusTimeline status={detail().status} target={detail().target} timeline={detail().timeline} />

              <Show
                when={requestCount() >= 20 && (detail().status === "validating" || detail().status === "publishing")}
              >
                <section class="submission-detail__polling" role="status">
                  自动刷新已暂停。
                  <button type="button" onClick={() => void submission.refetch()}>
                    手动刷新
                  </button>
                </section>
              </Show>

              <section class="submission-detail__section" aria-labelledby="submission-overview-title">
                <h2 class="type-section-title" id="submission-overview-title">投稿信息</h2>
                <p class="type-body">{detail().metadata.description}</p>
                <dl class="submission-detail__facts">
                  <div>
                    <dt class="type-label">分类</dt>
                    <dd class="type-body">{detail().metadata.category}</dd>
                  </div>
                  <div>
                    <dt>风险等级</dt>
                    <dd>{riskLabel(detail().risk)}</dd>
                  </div>
                  <div>
                    <dt>当前修订</dt>
                    <dd>{detail().currentRevision}</dd>
                  </div>
                  <div>
                    <dt>许可证</dt>
                    <dd>{detail().metadata.license ?? "未声明"}</dd>
                  </div>
                  <div>
                    <dt>API Key</dt>
                    <dd>{detail().metadata.requiresApiKey ? "需要" : "不需要"}</dd>
                  </div>
                  <div>
                    <dt>标签</dt>
                    <dd>{detail().metadata.tags.join("、") || "无"}</dd>
                  </div>
                </dl>
                <h3 class="type-card-title">变更说明</h3>
                <p class="type-body">{detail().metadata.changeNotes}</p>
              </section>

              <RevisionReport detail={detail()} />

              <section class="submission-detail__section" aria-labelledby="submission-revisions-title">
                <h2 class="type-section-title" id="submission-revisions-title">修订历史</h2>
                <ol class="submission-detail__history">
                  <For each={detail().revisions}>
                    {(revision) => (
                      <li>
                        <strong>修订 {revision.number}</strong>
                        <span>{revision.metadata.version}</span>
                        <time dateTime={revision.createdAt}>{formatDate(revision.createdAt)}</time>
                      </li>
                    )}
                  </For>
                </ol>
              </section>

              <Show when={detail().reviews.length > 0}>
                <section class="submission-detail__section" aria-labelledby="submission-reviews-title">
                  <h2 class="type-section-title" id="submission-reviews-title">审核记录</h2>
                  <ol class="submission-detail__history">
                    <For each={detail().reviews}>
                      {(review) => (
                        <li>
                          <strong>{decisionLabel(review.decision)}</strong>
                          <span>
                            {review.reviewer.displayName} · 修订 {review.revision}
                          </span>
                          <time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time>
                          <Show when={review.comment}>{(comment) => <p>{comment()}</p>}</Show>
                        </li>
                      )}
                    </For>
                  </ol>
                </section>
              </Show>
            </main>
          </Show>
        )}
      </Match>
    </Switch>
  )
}

function SubmissionActions(props: {
  detail: SkillMarketControl.SubmissionDetail
  packageUrl: string
  source: SubmissionDetailSource
  groups?: Pick<SkillMarketControlDataSource["groups"], "list">
  department?: SkillMarketControl.Department
  onPromoted: () => void
}) {
  const client = useQueryClient()
  const [sharing, setSharing] = createSignal(false)
  const [action, setAction] = createSignal<"withdraw" | "delist">()
  const [reason, setReason] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [delistRequest, setDelistRequest] = createSignal<SkillMarketControl.DelistRequest>()
  let actionTrigger: HTMLButtonElement | undefined
  const closeAction = () => {
    if (pending()) return
    setAction(undefined)
    setReason("")
    queueMicrotask(() => actionTrigger?.focus())
  }
  const submitAction = () => {
    const kind = action()
    if (!kind || pending()) return
    if (kind === "delist" && !reason().trim()) {
      setError("请填写下架原因")
      return
    }
    setPending(true)
    setError(undefined)
    if (kind === "withdraw") {
      void props.source
        .withdraw(props.detail.id, { expectedVersion: props.detail.version }, createIdempotencyKey())
        .then((result) => {
          client.setQueryData(["skill-market", "submission", props.detail.id], result)
          void client.invalidateQueries({ queryKey: ["skill-market", "submissions"] })
          setAction(undefined)
          queueMicrotask(() => actionTrigger?.focus())
        })
        .catch((cause: unknown) =>
          setError(cause instanceof MarketControlError ? `${cause.message}（请求编号：${cause.requestId}）` : "撤回投稿失败，请检查网络后重试。"),
        )
        .finally(() => setPending(false))
      return
    }
    void props.source
      .requestDelist(
        props.detail.id,
        { expectedVersion: props.detail.version, reason: reason().trim() },
        createIdempotencyKey(),
      )
      .then((result) => {
        setDelistRequest(result)
        setAction(undefined)
        setReason("")
        queueMicrotask(() => actionTrigger?.focus())
      })
      .catch((cause: unknown) =>
        setError(cause instanceof MarketControlError ? `${cause.message}（请求编号：${cause.requestId}）` : "下架申请提交失败，请检查网络后重试。"),
      )
      .finally(() => setPending(false))
  }
  return (
    <div class="submission-detail__actions">
      <Show when={props.detail.status === "validation_failed" || props.detail.status === "changes_requested"}>
        <A class="market-primary-action" href={`/submissions/${props.detail.id}?revise=1`}>
          提交修订
        </A>
      </Show>
      <Show when={props.detail.status === "rejected"}>
        <A class="market-primary-action" href={`/submissions/new?from=${encodeURIComponent(props.detail.id)}`}>
          重新投稿
        </A>
      </Show>
      <Show when={props.detail.status === "published"}>
        <A class="market-primary-action" href={`/submissions/new?from=${encodeURIComponent(props.detail.id)}`}>
          {props.detail.target === "personal" ? "上传新版本" : "提交新版本"}
        </A>
        <Show
          when={props.detail.target === "personal"}
          fallback={
            <A href={`/skills/community/${encodeURIComponent(props.detail.publicSkill?.id ?? props.detail.skillID)}`}>
              查看公开 Skill
            </A>
          }
        >
          <a href={props.packageUrl}>下载个人 Skill</a>
          <button type="button" onClick={() => setSharing((value) => !value)}>发布给其他人</button>
        </Show>
      </Show>
      <Show when={["validating", "validation_failed", "pending_review", "changes_requested", "publish_failed"].includes(props.detail.status)}>
        <button
          type="button"
          disabled={pending()}
          ref={(element) => {
            actionTrigger = element
          }}
          onClick={(event) => {
            actionTrigger = event.currentTarget
            setError(undefined)
            setAction("withdraw")
          }}
        >
          撤回投稿
        </button>
      </Show>
      <Show when={props.detail.status === "published" && props.detail.target !== "personal" && !delistRequest()}>
        <button
          type="button"
          disabled={pending()}
          ref={(element) => {
            actionTrigger = element
          }}
          onClick={(event) => {
            actionTrigger = event.currentTarget
            setError(undefined)
            setAction("delist")
          }}
        >
          申请下架
        </button>
      </Show>
      <Show when={delistRequest()}>
        {(request) => <span>下架申请{request().status === "pending" ? "待处理" : request().status === "approved" ? "已批准" : "已拒绝"}</span>}
      </Show>
      <Show when={sharing()}>
        <PromotionForm
          detail={props.detail}
          source={props.source}
          groups={props.groups}
          department={props.department}
          onPromoted={props.onPromoted}
        />
      </Show>
      <Show when={action()}>
        {(kind) => (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="submission-action-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeAction()
            }}
          >
            <h2 id="submission-action-title">{kind() === "withdraw" ? "撤回投稿" : "申请下架"}</h2>
            <p>
              {kind() === "withdraw"
                ? `确认撤回 ${props.detail.metadata.displayName} ${props.detail.targetVersion}？`
                : `确认申请下架 ${props.detail.metadata.displayName} ${props.detail.targetVersion}？`}
            </p>
            <Show when={kind() === "delist"}>
              <label class="submission-form__field">
                <span>下架原因</span>
                <textarea aria-label="下架原因" rows="3" value={reason()} disabled={pending()} onInput={(event) => setReason(event.currentTarget.value)} />
              </label>
            </Show>
            <Show when={error()}>{(message) => <div class="submission-form__errors" role="alert">{message()}</div>}</Show>
            <div>
              <button type="button" disabled={pending()} ref={(element) => queueMicrotask(() => element.focus())} onClick={closeAction}>取消</button>
              <button type="button" class="market-primary-action" disabled={pending()} onClick={submitAction}>
                {pending() ? "正在提交…" : kind() === "withdraw" ? "确认撤回" : "确认申请下架"}
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

function PromotionForm(props: {
  detail: SkillMarketControl.SubmissionDetail
  source: SubmissionDetailSource
  groups?: Pick<SkillMarketControlDataSource["groups"], "list">
  department?: SkillMarketControl.Department
  onPromoted: () => void
}) {
  const [target, setTarget] = createSignal<"groups" | "department" | "company">("company")
  const [groupIDs, setGroupIDs] = createSignal<SkillMarketControl.GroupID[]>([])
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const groups = createQuery(() => ({
    queryKey: ["skill-market", "groups", "promotion"] as const,
    queryFn: ({ signal }) => props.groups?.list(signal) ?? Promise.resolve({ managed: [], joined: [] }),
    enabled: target() === "groups" && Boolean(props.groups),
  }))
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (pending()) return
    if (target() === "groups" && groupIDs().length === 0) return setError("请至少选择一个小组。")
    const audience =
      target() === "groups"
        ? { scope: "groups" as const, groupIDs: groupIDs() }
        : target() === "department"
          ? { scope: "department" as const }
          : undefined
    setPending(true)
    setError(undefined)
    void props.source
      .promote(
        props.detail.id,
        { expectedVersion: props.detail.version, target: target(), ...(audience ? { audience } : {}) },
        createIdempotencyKey(),
      )
      .then(props.onPromoted)
      .catch(() => setError("发布申请提交失败，请稍后重试。"))
      .finally(() => setPending(false))
  }
  return (
    <form class="submission-promotion" aria-label="发布给其他人" onSubmit={submit}>
      <fieldset>
        <legend>选择新的可见范围</legend>
        <label><input type="radio" name="promotion-target" checked={target() === "groups"} onChange={() => setTarget("groups")} />指定小组</label>
        <label><input type="radio" name="promotion-target" disabled={!props.department} checked={target() === "department"} onChange={() => setTarget("department")} />本部门</label>
        <label><input type="radio" name="promotion-target" checked={target() === "company"} onChange={() => setTarget("company")} />全公司</label>
      </fieldset>
      <Show when={target() === "groups"}>
        <div class="submission-promotion__groups">
          <For each={groups.data?.managed.filter((group) => group.status === "active") ?? []}>
            {(group) => <label><input type="checkbox" checked={groupIDs().includes(group.id)} onChange={(event) => setGroupIDs((current) => event.currentTarget.checked ? [...current, group.id] : current.filter((id) => id !== group.id))} />{group.name}</label>}
          </For>
        </div>
      </Show>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <button type="submit" class="market-primary-action" disabled={pending()}>{pending() ? "正在提交…" : "提交审核"}</button>
    </form>
  )
}

function RevisionReport(props: { detail: SkillMarketControl.SubmissionDetail }) {
  const revision = () =>
    props.detail.revisions.find((item) => item.number === props.detail.currentRevision) ?? props.detail.revisions.at(-1)
  return (
    <>
      <Show when={revision()?.validationIssues.length}>
        <section class="submission-detail__section" aria-labelledby="submission-validation-title">
          <h2 id="submission-validation-title">校验报告</h2>
          <ul class="submission-report-list">
            <For each={revision()?.validationIssues}>
              {(issue) => (
                <li>
                  <strong>{issue.code}</strong>
                  <p>{issue.message}</p>
                  <Show when={issue.path}>{(path) => <code>{path()}</code>}</Show>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={revision()?.scan}>
        {(scan) => (
          <section class="submission-detail__section" aria-labelledby="submission-scan-title">
            <h2 id="submission-scan-title">安全扫描</h2>
            <p>风险等级：{riskLabel(scan().risk)}</p>
            <ul class="submission-report-list">
              <For each={scan().evidence}>
                {(evidence) => (
                  <li>
                    <strong>{evidence.rule}</strong>
                    <p>{evidence.summary}</p>
                    <Show when={evidence.path}>
                      {(path) => (
                        <code>
                          {path()}
                          {evidence.line ? `:${evidence.line}` : ""}
                        </code>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </Show>
      <Show when={revision()?.manifest}>
        {(manifest) => (
          <section class="submission-detail__section" aria-labelledby="submission-manifest-title">
            <h2 id="submission-manifest-title">文件清单</h2>
            <p>
              {manifest().files.length} 个文件 · {formatBytes(manifest().packageSize)}
            </p>
            <ul class="submission-manifest">
              <For each={manifest().files.slice(0, 100)}>{(file) => <li>{file.path}</li>}</For>
            </ul>
            <Show when={manifest().files.length > 100}>
              <p>文件较多，此处仅展示前 100 个；完整清单保留在审核记录中。</p>
            </Show>
          </section>
        )}
      </Show>
    </>
  )
}

function riskLabel(risk: SkillMarketControl.SubmissionSummary["risk"]) {
  if (risk === "safe") return "安全"
  if (risk === "warning") return "警告"
  if (risk === "danger") return "危险"
  return "未知"
}

function decisionLabel(decision: SkillMarketControl.ReviewDecision) {
  if (decision === "approve") return "审核通过"
  if (decision === "request_changes") return "要求修改"
  return "审核拒绝"
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

function createIdempotencyKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
