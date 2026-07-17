import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query"
import { Match, Show, Switch, createSignal } from "solid-js"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"

export type SkillHubImportSource = Pick<SkillMarketControlDataSource["skillhub"], "status" | "command">

interface SkillHubImportProps {
  readonly source: SkillHubImportSource
}

export function SkillHubImport(props: SkillHubImportProps) {
  const client = useQueryClient()
  const [rejectedSlugs, setRejectedSlugs] = createSignal("")
  const [confirmRejected, setConfirmRejected] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const status = createQuery(() => ({
    queryKey: ["skill-market", "skillhub-import"] as const,
    queryFn: ({ signal }) => props.source.status(signal),
    refetchInterval: (query) => (query.state.data?.state === "running" ? 5_000 : 30_000),
  }))
  const command = createMutation(() => ({
    mutationFn: (input: SkillMarketControl.SkillHubImportCommandInput) => props.source.command(input),
    onSuccess: (next) => {
      client.setQueryData(["skill-market", "skillhub-import"], next)
      setConfirmRejected(false)
      setError(undefined)
    },
    onError: (cause: unknown) => setError(errorMessage(cause)),
  }))
  const pending = () => command.isPending
  const send = (input: SkillMarketControl.SkillHubImportCommandInput) => {
    if (pending()) return
    setError(undefined)
    command.mutate(input)
  }
  const slugs = () => [...new Set(rejectedSlugs().split(",").map((value) => value.trim()).filter(Boolean))]

  return (
    <Switch>
      <Match when={status.isPending}>
        <main class="submission-page">
          <section class="submission-state" role="status">
            正在加载 SkillHub 同步进度…
          </section>
        </main>
      </Match>
      <Match when={status.error}>
        <main class="submission-page">
          <section class="submission-state" role="alert">
            <h1>SkillHub 同步进度加载失败</h1>
            <p>请检查网络后重试。</p>
            <button type="button" onClick={() => void status.refetch()}>
              重新加载
            </button>
          </section>
        </main>
      </Match>
      <Match when={status.data}>
        {(progress) => (
          <main class="submission-page skillhub-import-page">
            <header class="submission-page__heading">
              <div>
                <p class="submission-page__eyebrow">Admin workspace</p>
                <h1>SkillHub 同步</h1>
                <p>查看上游 SkillHub 导入状态，并按需要控制同步队列。</p>
              </div>
              <span class={`skillhub-import-state skillhub-import-state--${progress().state}`}>{stateLabel(progress().state)}</span>
            </header>

            <section class="skillhub-import-progress" aria-label="同步进度概览">
              <div class="skillhub-import-progress__heading">
                <span>已处理 {formatNumber(progress().mirrored + progress().rejected)} / {formatNumber(progress().upstreamTotal)}</span>
                <strong>{formatPercent(progress())}</strong>
              </div>
              <div
                class="skillhub-import-progress__bar"
                role="progressbar"
                aria-label="导入进度"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={roundedProgressPercent(progress())}
              >
                <span style={{ width: `${progressPercent(progress())}%` }} />
              </div>
            </section>

            <section class="skillhub-import-cards" aria-label="同步统计">
              <StatCard label="已发现" value={formatNumber(progress().discovered)} />
              <StatCard label="已镜像" value={formatNumber(progress().mirrored)} />
              <StatCard label="等待重试" value={formatNumber(progress().retryWait)} />
              <StatCard label="已拒绝" value={formatNumber(progress().rejected)} />
              <StatCard label="已上传" value={formatBytes(progress().uploadedBytes)} />
              <StatCard label="导入速率" value={`${formatNumber(progress().ratePerMinute)} 个/分钟`} />
              <StatCard label="预计剩余时间" value={formatEta(progress().estimatedSecondsRemaining)} />
            </section>

            <dl class="skillhub-import-details">
              <div>
                <dt>当前发现页</dt>
                <dd>{formatNumber(progress().discoveryPage)}</dd>
              </div>
              <div>
                <dt>扫描轮次</dt>
                <dd>{formatNumber(progress().sweep)}</dd>
              </div>
              <div>
                <dt>并发数</dt>
                <dd>元数据 {progress().metadataConcurrency} · 包 {progress().packageConcurrency}</dd>
              </div>
              <div>
                <dt>来源状态</dt>
                <dd>{sourceLabel(progress().sourceStatus)}</dd>
              </div>
            </dl>

            <Show when={progress().recentError}>
              {(recent) => (
                <section class="submission-form__errors skillhub-import-error" role="alert">
                  最近错误：{recent().summary}
                </section>
              )}
            </Show>
            <Show when={error()}>
              {(message) => (
                <section class="submission-form__errors skillhub-import-error" role="alert">
                  {message()}
                </section>
              )}
            </Show>

            <section class="skillhub-import-controls" aria-label="同步控制">
              <Show when={progress().state === "running"}>
                <button type="button" disabled={pending()} onClick={() => send({ command: "pause" })}>
                  暂停同步
                </button>
              </Show>
              <Show when={progress().state !== "running"}>
                <button type="button" class="market-primary-action" disabled={pending()} onClick={() => send({ command: "resume" })}>
                  恢复同步
                </button>
              </Show>
              <Show when={progress().retryWait > 0}>
                <button type="button" disabled={pending()} onClick={() => send({ command: "retry-wait" })}>
                  重试等待项（{formatNumber(progress().retryWait)}）
                </button>
              </Show>
              <Show when={progress().rejected > 0}>
                <label class="skillhub-import-controls__slugs">
                  <span>已拒绝 Skill 的 slug</span>
                  <input
                    value={rejectedSlugs()}
                    disabled={pending()}
                    onInput={(event) => {
                      setRejectedSlugs(event.currentTarget.value)
                      setConfirmRejected(false)
                    }}
                    placeholder="以逗号分隔，例如 unsafe-skill"
                  />
                </label>
                <button
                  type="button"
                  class="admin-danger-action"
                  disabled={pending() || slugs().length === 0}
                  onClick={() => setConfirmRejected(true)}
                >
                  重试已拒绝项（{formatNumber(progress().rejected)}）
                </button>
              </Show>
            </section>

            <Show when={confirmRejected()}>
              <section class="skillhub-import-confirmation" role="region" aria-label="重试已拒绝项确认">
                <p>将重新排队 {slugs().length} 个已拒绝的 Skill。请确认后继续。</p>
                <div>
                  <button type="button" disabled={pending()} onClick={() => setConfirmRejected(false)}>
                    取消
                  </button>
                  <button
                    type="button"
                    class="market-primary-action"
                    disabled={pending() || slugs().length === 0}
                    onClick={() => send({ command: "retry-rejected", slugs: slugs() })}
                  >
                    确认重试已拒绝项
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

function StatCard(props: { readonly label: string; readonly value: string }) {
  return (
    <article aria-label={props.label}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </article>
  )
}

function progressPercent(progress: SkillMarketControl.SkillHubImportProgress) {
  if (progress.upstreamTotal === 0) return 0
  return Math.min(100, ((progress.mirrored + progress.rejected) / progress.upstreamTotal) * 100)
}

function formatPercent(progress: SkillMarketControl.SkillHubImportProgress) {
  return `${roundedProgressPercent(progress)}%`
}

function roundedProgressPercent(progress: SkillMarketControl.SkillHubImportProgress) {
  return Number(progressPercent(progress).toFixed(1))
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value)
}

function formatBytes(value: number) {
  if (value < 1024) return `${formatNumber(value)} B`
  const units = ["KB", "MB", "GB", "TB"]
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length)
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value / 1024 ** exponent)} ${units[exponent - 1]}`
}

function formatEta(seconds: number | undefined) {
  if (seconds === undefined) return "未知"
  if (seconds < 60) return "少于 1 分钟"
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)} 分钟`
  return `${Math.floor(seconds / 3_600)} 小时 ${Math.ceil((seconds % 3_600) / 60)} 分钟`
}

function stateLabel(state: SkillMarketControl.SkillHubImportState) {
  return ({ idle: "空闲", running: "同步中", paused: "已暂停", completed: "已完成", failed: "失败" })[state]
}

function sourceLabel(status: SkillMarketControl.SkillHubImportProgress["sourceStatus"]) {
  return ({ fresh: "最新", stale: "过期", unavailable: "不可用" })[status]
}

function errorMessage(cause: unknown) {
  if (cause instanceof MarketControlError) return `${cause.message}（请求编号：${cause.requestId}）`
  return "同步控制操作失败，请检查网络后重试。"
}
