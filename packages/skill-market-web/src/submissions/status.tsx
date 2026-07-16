import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { For } from "solid-js"

const presentations: Record<SkillMarketControl.SubmissionStatus, { label: string; message: string }> = {
  validating: { label: "校验中", message: "正在校验 ZIP 结构和安全规则" },
  validation_failed: { label: "校验失败", message: "校验未通过" },
  pending_review: { label: "待审核", message: "已进入人工审核队列" },
  changes_requested: { label: "需修改", message: "审核人要求修改" },
  rejected: { label: "已拒绝", message: "本次投稿已被拒绝" },
  publishing: { label: "发布中", message: "审核已通过，正在发布" },
  publish_failed: { label: "发布失败", message: "自动发布失败" },
  published: { label: "已发布", message: "已发布到用户投稿市场" },
}

export function SubmissionStatusTimeline(props: {
  status: SkillMarketControl.SubmissionStatus
  timeline: ReadonlyArray<SkillMarketControl.StatusEvent>
}) {
  return (
    <section class="submission-detail__section" aria-labelledby="submission-timeline-title">
      <div class="submission-detail__section-heading">
        <h2 id="submission-timeline-title">状态时间线</h2>
        <span class={`submission-status submission-status--${props.status}`}>{statusLabel(props.status)}</span>
      </div>
      <p class="submission-status-message" aria-live="polite">
        {statusMessage(props.status)}
      </p>
      <ol class="submission-timeline">
        <For each={props.timeline}>
          {(event) => (
            <li data-status-event>
              <span class="submission-timeline__dot" aria-hidden="true" />
              <div>
                <strong>{statusLabel(event.status)}</strong>
                <time dateTime={event.at}>{formatDate(event.at)}</time>
                {event.message ? <p>{event.message}</p> : undefined}
              </div>
            </li>
          )}
        </For>
      </ol>
    </section>
  )
}

export function statusLabel(status: SkillMarketControl.SubmissionStatus) {
  return presentations[status].label
}

export function statusMessage(status: SkillMarketControl.SubmissionStatus) {
  return presentations[status].message
}

export function submissionPollInterval(status: SkillMarketControl.SubmissionStatus | undefined, requestCount: number) {
  if (requestCount >= 20) return false
  if (status === "validating" || status === "publishing") return 2_000
  return false
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}
