import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { A, useSearchParams } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createSignal } from "solid-js"
import type { SkillMarketControlDataSource } from "../control-data-source"
import { SubmissionForm } from "./form"
import { SubmissionStatusTimeline, submissionPollInterval } from "./status"

export type SubmissionDetailSource = Pick<SkillMarketControlDataSource["submissions"], "detail" | "create" | "revise">

interface SubmissionDetailProps {
  readonly submissionID: string
  readonly source: SubmissionDetailSource
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
            <h1>投稿详情加载失败</h1>
            <p>请检查网络后重试。</p>
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
                  <A href="/submissions">← 返回我的投稿</A>
                  <h1>{detail().metadata.displayName}</h1>
                  <p>
                    {detail().skillID} · 目标版本 {detail().targetVersion}
                  </p>
                </div>
                <SubmissionActions detail={detail()} />
              </header>

              <SubmissionStatusTimeline status={detail().status} timeline={detail().timeline} />

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
                <h2 id="submission-overview-title">投稿信息</h2>
                <p>{detail().metadata.description}</p>
                <dl class="submission-detail__facts">
                  <div>
                    <dt>分类</dt>
                    <dd>{detail().metadata.category}</dd>
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
                <h3>变更说明</h3>
                <p>{detail().metadata.changeNotes}</p>
              </section>

              <RevisionReport detail={detail()} />

              <section class="submission-detail__section" aria-labelledby="submission-revisions-title">
                <h2 id="submission-revisions-title">修订历史</h2>
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
                  <h2 id="submission-reviews-title">审核记录</h2>
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

function SubmissionActions(props: { detail: SkillMarketControl.SubmissionDetail }) {
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
          提交新版本
        </A>
        <A href={`/skills/community/${encodeURIComponent(props.detail.publicSkill?.id ?? props.detail.skillID)}`}>
          查看公开 Skill
        </A>
      </Show>
    </div>
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
