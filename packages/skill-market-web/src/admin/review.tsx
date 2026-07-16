import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { A } from "@solidjs/router"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createSignal } from "solid-js"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"
import { SubmissionStatusTimeline } from "../submissions/status"

export type ModerationReviewSource = Pick<SkillMarketControlDataSource["moderation"], "detail" | "decide">
export type ModerationOperationsSource = Pick<
  SkillMarketControlDataSource["moderation"],
  "retryPublish" | "delist" | "restore"
>

interface ModerationReviewProps {
  readonly submissionID: string
  readonly source: ModerationReviewSource
  readonly actor: string
  readonly admin?: boolean
  readonly operations?: ModerationOperationsSource
  readonly onDecided?: (detail: SkillMarketControl.SubmissionDetail) => void
}

export function ModerationReview(props: ModerationReviewProps) {
  const client = useQueryClient()
  const [decision, setDecision] = createSignal<SkillMarketControl.ReviewDecision>("request_changes")
  const [comment, setComment] = createSignal("")
  const [confirmation, setConfirmation] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [pending, setPending] = createSignal(false)
  const [filePage, setFilePage] = createSignal(1)
  const submission = createQuery(() => ({
    queryKey: ["skill-market", "moderation", "detail", props.submissionID] as const,
    queryFn: ({ signal }) => props.source.detail(props.submissionID, signal),
  }))
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const detail = submission.data
    if (!detail || pending() || detail.owner.employeeID === props.actor || detail.status !== "pending_review") return
    if (!comment().trim()) {
      setError("请填写审核意见")
      return
    }
    if (requiresConfirmation(detail) && confirmation().trim() !== detail.skillID) {
      setError(`请输入 ${detail.skillID} 以确认`)
      return
    }
    const input: SkillMarketControl.DecisionInput = {
      expectedVersion: detail.version,
      decision: decision(),
      comment: comment().trim(),
      ...(decision() === "approve" && requiresConfirmation(detail)
        ? { acceptedRiskSummary: acceptedRiskSummary(detail) }
        : {}),
    }
    setError(undefined)
    setPending(true)
    void props.source
      .decide(detail.id, input)
      .then((result) => {
        client.setQueryData(["skill-market", "moderation", "detail", detail.id], result)
        void client.invalidateQueries({ queryKey: ["skill-market", "moderation"] })
        void client.invalidateQueries({ queryKey: ["skill-market", "submissions"] })
        void client.invalidateQueries({ queryKey: ["skill-market", "list"] })
        void client.invalidateQueries({ queryKey: ["skill-market", "detail"] })
        props.onDecided?.(result)
      })
      .catch((cause: unknown) => {
        if (cause instanceof MarketControlError && cause.code === "submission-conflict") {
          setError(`投稿已更新，已刷新到最新版本（请求编号：${cause.requestId}）`)
          void submission.refetch()
          return
        }
        setError(
          cause instanceof MarketControlError
            ? `${cause.message}（请求编号：${cause.requestId}）`
            : "审核决定提交失败，请检查网络后重试。",
        )
      })
      .finally(() => setPending(false))
  }

  return (
    <Switch>
      <Match when={submission.isPending}>
        <main class="submission-page">
          <section class="submission-state" role="status">
            正在加载审核详情…
          </section>
        </main>
      </Match>
      <Match when={submission.error}>
        <main class="submission-page">
          <section class="submission-state" role="alert">
            <h1>审核详情加载失败</h1>
            <button type="button" onClick={() => void submission.refetch()}>
              重新加载
            </button>
          </section>
        </main>
      </Match>
      <Match when={submission.data}>
        {(detail) => {
          const revision = () =>
            detail().revisions.find((item) => item.number === detail().currentRevision) ?? detail().revisions.at(-1)
          const files = () => revision()?.manifest?.files ?? []
          const pageFiles = () => files().slice((filePage() - 1) * 100, filePage() * 100)
          const pages = () => Math.max(1, Math.ceil(files().length / 100))
          const selfReview = () => detail().owner.employeeID === props.actor
          return (
            <main class="submission-page moderation-review">
              <header class="submission-detail__header">
                <div>
                  <A href="/admin">← 返回审核队列</A>
                  <h1>审核 {detail().metadata.displayName}</h1>
                  <p>
                    {detail().skillID} · 投稿人 {detail().owner.displayName}（{detail().owner.employeeID}）
                  </p>
                </div>
                <span class={`moderation-risk moderation-risk--${detail().risk}`}>{riskLabel(detail().risk)}</span>
              </header>

              <SubmissionStatusTimeline status={detail().status} timeline={detail().timeline} />

              <Show when={props.admin && props.operations}>
                {(operations) => (
                  <AdminOperations
                    detail={detail()}
                    source={operations()}
                    onDetail={(result) =>
                      client.setQueryData(["skill-market", "moderation", "detail", detail().id], result)
                    }
                    onPublicSkill={(result) =>
                      client.setQueryData<SkillMarketControl.SubmissionDetail>(
                        ["skill-market", "moderation", "detail", detail().id],
                        (current) => (current ? { ...current, publicSkill: result } : current),
                      )
                    }
                    onConflict={() => void submission.refetch()}
                  />
                )}
              </Show>

              <section class="submission-detail__section moderation-review__overview">
                <h2>投稿概览</h2>
                <p>{detail().metadata.description}</p>
                <dl class="submission-detail__facts">
                  <div>
                    <dt>目标版本</dt>
                    <dd>{detail().targetVersion}</dd>
                  </div>
                  <div>
                    <dt>并发版本</dt>
                    <dd>{detail().version}</dd>
                  </div>
                  <div>
                    <dt>当前修订</dt>
                    <dd>{detail().currentRevision}</dd>
                  </div>
                  <div>
                    <dt>分类</dt>
                    <dd>{detail().metadata.category}</dd>
                  </div>
                  <div>
                    <dt>API Key</dt>
                    <dd>{detail().metadata.requiresApiKey ? "需要" : "不需要"}</dd>
                  </div>
                  <div>
                    <dt>变更说明</dt>
                    <dd>{detail().metadata.changeNotes}</dd>
                  </div>
                </dl>
              </section>

              <Show when={revision()?.scan}>
                {(scan) => (
                  <section class="submission-detail__section">
                    <h2>安全扫描</h2>
                    <p class={`moderation-risk-summary moderation-risk-summary--${scan().risk}`}>
                      {riskLabel(scan().risk)}：{scan().reasons.join("；") || "没有附加原因"}
                    </p>
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

              <section class="submission-detail__section">
                <div class="submission-detail__section-heading">
                  <h2>文件清单</h2>
                  <span>
                    第 {filePage()} / {pages()} 页 · 共 {files().length} 个文件
                  </span>
                </div>
                <ul class="submission-manifest">
                  <For each={pageFiles()}>{(file) => <li>{file.path}</li>}</For>
                </ul>
                <nav class="moderation-file-pagination" aria-label="文件清单分页">
                  <button type="button" disabled={filePage() <= 1} onClick={() => setFilePage((page) => page - 1)}>
                    上一页
                  </button>
                  <button
                    type="button"
                    disabled={filePage() >= pages()}
                    onClick={() => setFilePage((page) => page + 1)}
                  >
                    下一页
                  </button>
                </nav>
              </section>

              <Show when={detail().reviews.length > 0}>
                <section class="submission-detail__section">
                  <h2>历史审核</h2>
                  <ol class="submission-detail__history">
                    <For each={detail().reviews}>
                      {(review) => (
                        <li>
                          <strong>{decisionLabel(review.decision)}</strong>
                          <span>{review.reviewer.displayName}</span>
                          <time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time>
                          <Show when={review.comment}>{(value) => <p>{value()}</p>}</Show>
                        </li>
                      )}
                    </For>
                  </ol>
                </section>
              </Show>

              <section class="submission-detail__section moderation-decision" aria-labelledby="decision-title">
                <h2 id="decision-title">审核决定</h2>
                <Show when={selfReview()}>
                  <div class="moderation-decision__notice" role="alert">
                    <strong>不能审核自己的投稿</strong>
                    <p>请由其他 Reviewer 或 Admin 处理此投稿。</p>
                  </div>
                </Show>
                <Show when={detail().status !== "pending_review"}>
                  <div class="moderation-decision__notice">当前状态为 {detail().status}，不能再提交审核决定。</div>
                </Show>
                <form onSubmit={submit} onInput={() => setError(undefined)}>
                  <fieldset disabled={pending() || selfReview() || detail().status !== "pending_review"}>
                    <legend>选择决定</legend>
                    <label>
                      <input
                        aria-label="通过"
                        type="radio"
                        name="decision"
                        value="approve"
                        checked={decision() === "approve"}
                        onChange={() => setDecision("approve")}
                      />
                      通过
                    </label>
                    <label>
                      <input
                        aria-label="要求修改"
                        type="radio"
                        name="decision"
                        value="request_changes"
                        checked={decision() === "request_changes"}
                        onChange={() => setDecision("request_changes")}
                      />
                      要求修改
                    </label>
                    <label>
                      <input
                        aria-label="拒绝"
                        type="radio"
                        name="decision"
                        value="reject"
                        checked={decision() === "reject"}
                        onChange={() => setDecision("reject")}
                      />
                      拒绝
                    </label>
                  </fieldset>
                  <label class="submission-form__field">
                    <span>审核意见</span>
                    <textarea
                      aria-label="审核意见"
                      rows="5"
                      value={comment()}
                      disabled={pending() || selfReview() || detail().status !== "pending_review"}
                      onInput={(event) => setComment(event.currentTarget.value)}
                    />
                  </label>
                  <Show when={requiresConfirmation(detail())}>
                    <label class="submission-form__field moderation-decision__confirmation">
                      <span>输入 Skill ID 以确认</span>
                      <small>
                        当前风险为{riskLabel(detail().risk)}。请输入 <strong>{detail().skillID}</strong>{" "}
                        确认已检查风险摘要。
                      </small>
                      <input
                        aria-label="输入 Skill ID 以确认"
                        value={confirmation()}
                        disabled={pending() || selfReview() || detail().status !== "pending_review"}
                        onInput={(event) => setConfirmation(event.currentTarget.value)}
                      />
                    </label>
                  </Show>
                  <Show when={error()}>
                    {(message) => (
                      <div class="submission-form__errors" role="alert">
                        {message()}
                      </div>
                    )}
                  </Show>
                  <button
                    type="submit"
                    class="market-primary-action"
                    disabled={pending() || selfReview() || detail().status !== "pending_review"}
                  >
                    {pending() ? "正在提交…" : "提交审核决定"}
                  </button>
                </form>
              </section>
            </main>
          )
        }}
      </Match>
    </Switch>
  )
}

function AdminOperations(props: {
  detail: SkillMarketControl.SubmissionDetail
  source: ModerationOperationsSource
  onDetail: (detail: SkillMarketControl.SubmissionDetail) => void
  onPublicSkill: (skill: SkillMarketControl.PublicSkill) => void
  onConflict: () => void
}) {
  const [action, setAction] = createSignal<"delist" | "restore">()
  const [reason, setReason] = createSignal("")
  const [error, setError] = createSignal<string>()
  const [pending, setPending] = createSignal(false)
  const retry = () => {
    if (pending()) return
    setPending(true)
    setError(undefined)
    void props.source
      .retryPublish(props.detail.id, { expectedVersion: props.detail.version })
      .then(props.onDetail)
      .catch((cause: unknown) => operationError(cause, setError, props.onConflict))
      .finally(() => setPending(false))
  }
  const updatePublicStatus = () => {
    const kind = action()
    const publicSkill = props.detail.publicSkill
    if (!kind || !publicSkill || pending()) return
    if (!reason().trim()) {
      setError("请填写操作原因")
      return
    }
    setPending(true)
    setError(undefined)
    const request =
      kind === "delist"
        ? props.source.delist(publicSkill.id, { expectedVersion: publicSkill.rowVersion, reason: reason().trim() })
        : props.source.restore(publicSkill.id, { expectedVersion: publicSkill.rowVersion, reason: reason().trim() })
    void request
      .then((result) => {
        props.onPublicSkill(result)
        setAction(undefined)
        setReason("")
      })
      .catch((cause: unknown) => operationError(cause, setError, props.onConflict))
      .finally(() => setPending(false))
  }

  return (
    <section class="submission-detail__section admin-operations" aria-labelledby="admin-operations-title">
      <div class="submission-detail__section-heading">
        <div>
          <h2 id="admin-operations-title">Admin 操作</h2>
          <p>运营操作会写入审计日志并使用乐观并发控制。</p>
        </div>
        <div class="admin-operations__actions">
          <Show when={props.detail.status === "publish_failed"}>
            <button type="button" class="market-primary-action" disabled={pending()} onClick={retry}>
              重试发布
            </button>
          </Show>
          <Show when={props.detail.publicSkill?.status === "published"}>
            <button
              type="button"
              class="admin-danger-action"
              disabled={pending()}
              onClick={() => {
                setError(undefined)
                setAction("delist")
              }}
            >
              下架 Skill
            </button>
          </Show>
          <Show when={props.detail.publicSkill?.status === "delisted"}>
            <button
              type="button"
              class="market-primary-action"
              disabled={pending()}
              onClick={() => {
                setError(undefined)
                setAction("restore")
              }}
            >
              恢复 Skill
            </button>
          </Show>
        </div>
      </div>

      <Show when={action()}>
        {(kind) => (
          <div class="admin-operation-confirmation">
            <strong>{kind() === "delist" ? "确认下架" : "确认恢复"}</strong>
            <p>
              {kind() === "delist"
                ? "下架会移除公开可见性，但保留包与全部历史。"
                : "恢复会重新公开当前已发布版本，并触发目录重建。"}
            </p>
            <label class="submission-form__field">
              <span>操作原因</span>
              <textarea
                aria-label="操作原因"
                rows="3"
                value={reason()}
                onInput={(event) => {
                  setReason(event.currentTarget.value)
                  setError(undefined)
                }}
              />
            </label>
            <div>
              <button type="button" onClick={() => setAction(undefined)}>
                取消
              </button>
              <button type="button" class="market-primary-action" disabled={pending()} onClick={updatePublicStatus}>
                {kind() === "delist" ? "确认下架" : "确认恢复"}
              </button>
            </div>
          </div>
        )}
      </Show>
      <Show when={error()}>
        {(message) => (
          <div class="submission-form__errors" role="alert">
            {message()}
          </div>
        )}
      </Show>
    </section>
  )
}

function operationError(cause: unknown, setError: (value: string) => void, onConflict: () => void) {
  if (cause instanceof MarketControlError && cause.code === "submission-conflict") {
    setError(`对象已更新，已刷新最新状态（请求编号：${cause.requestId}）`)
    onConflict()
    return
  }
  setError(
    cause instanceof MarketControlError
      ? `${cause.message}（请求编号：${cause.requestId}）`
      : "Admin 操作失败，请检查网络后重试。",
  )
}

function requiresConfirmation(detail: SkillMarketControl.SubmissionDetail) {
  return detail.risk === "warning" || detail.risk === "danger"
}

function acceptedRiskSummary(detail: SkillMarketControl.SubmissionDetail) {
  const scan = detail.revisions.find((item) => item.number === detail.currentRevision)?.scan
  return `${riskLabel(detail.risk)}：${scan?.reasons.join("；") || "没有附加原因"}`
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
