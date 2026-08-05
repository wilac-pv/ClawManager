import { A } from "@solidjs/router"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Show, createSignal } from "solid-js"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"

export type AnnouncementAdministrationSource = Pick<
  SkillMarketControlDataSource["announcements"],
  "publish"
>

export function AnnouncementAdministration(props: { readonly source: AnnouncementAdministrationSource }) {
  const [title, setTitle] = createSignal("")
  const [summary, setSummary] = createSignal("")
  const [content, setContent] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [published, setPublished] = createSignal<SkillMarket.AnnouncementDetail>()

  const publish = (event: SubmitEvent) => {
    event.preventDefault()
    if (pending()) return
    const input: SkillMarketControl.AnnouncementCreateInput = {
      title: title().trim(),
      summary: summary().trim(),
      content: content().trim(),
    }
    if (!input.title || !input.summary || !input.content) {
      setError("请完整填写公告标题、摘要和正文。")
      return
    }
    setPending(true)
    setError(undefined)
    setPublished(undefined)
    void props.source
      .publish(input)
      .then((result) => {
        setPublished(result)
        setTitle("")
        setSummary("")
        setContent("")
      })
      .catch((cause: unknown) =>
        setError(cause instanceof MarketControlError ? cause.message : "公告发布失败，请稍后重试。"),
      )
      .finally(() => setPending(false))
  }

  return (
    <main class="submission-page announcement-admin">
      <header class="submission-page__heading">
        <div>
          <h1 class="type-page-title">公告发布</h1>
          <p class="type-secondary">发布后立即展示在 Skill 市场首页和公告历史中。公告为永久记录，发布后不可修改或删除。</p>
        </div>
        <A class="submission-page__primary" href="/announcements">
          查看公告历史
        </A>
      </header>

      <form class="announcement-admin__form" onSubmit={publish} onInput={() => setError(undefined)}>
        <label>
          <span class="type-label">公告标题</span>
          <input
            aria-label="公告标题"
            required
            maxlength={120}
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
            placeholder="例如：Skill 市场新功能上线"
          />
          <small>{title().length}/120</small>
        </label>
        <label>
          <span class="type-label">首页摘要</span>
          <textarea
            aria-label="首页摘要"
            required
            maxlength={300}
            rows={3}
            value={summary()}
            onInput={(event) => setSummary(event.currentTarget.value)}
            placeholder="用于首页走马灯和公告列表的简短说明"
          />
          <small>{summary().length}/300</small>
        </label>
        <label>
          <span class="type-label">公告正文</span>
          <textarea
            aria-label="公告正文"
            required
            maxlength={20_000}
            rows={16}
            value={content()}
            onInput={(event) => setContent(event.currentTarget.value)}
            placeholder="支持简单 Markdown，可使用标题和列表"
          />
          <small>{content().length}/20000</small>
        </label>

        <Show when={error()}>
          {(message) => (
            <div class="submission-form__errors" role="alert">
              {message()}
            </div>
          )}
        </Show>
        <Show when={published()}>
          {(announcement) => (
            <div class="announcement-admin__success" role="status">
              <strong class="type-card-title">公告已发布</strong>
              <A href={`/announcements/${announcement().id}`}>查看公告详情</A>
            </div>
          )}
        </Show>
        <button type="submit" class="market-primary-action" disabled={pending()}>
          {pending() ? "正在发布…" : "立即发布公告"}
        </button>
      </form>
    </main>
  )
}
