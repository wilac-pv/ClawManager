import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createSignal } from "solid-js"
import { MarketControlError, type SkillMarketControlDataSource } from "../control-data-source"
import { SpacePageHeader } from "./page"

export type PersonalTrashSource = Pick<SkillMarketControlDataSource["submissions"], "personalTrash" | "restorePersonal">

export function PersonalTrash(props: { readonly source: PersonalTrashSource }) {
  const client = useQueryClient()
  const [pending, setPending] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const trash = createQuery(() => ({
    queryKey: ["skill-market", "personal-trash"] as const,
    queryFn: ({ signal }) => props.source.personalTrash(signal),
  }))
  const restore = (item: SkillMarketControl.PersonalTrashItem) => {
    if (pending() || new Date(item.purgeAfter).getTime() <= Date.now()) return
    setPending(item.id)
    setError(undefined)
    void props.source
      .restorePersonal(item.id, { expectedVersion: item.version }, createIdempotencyKey())
      .then(() => {
        void client.invalidateQueries({ queryKey: ["skill-market", "personal-trash"] })
        void client.invalidateQueries({ queryKey: ["skill-market", "submissions"] })
      })
      .catch((cause: unknown) =>
        setError(
          cause instanceof MarketControlError
            ? `${cause.message}（请求编号：${cause.requestId}）`
            : "恢复个人 Skill 失败，请检查网络后重试。",
        ),
      )
      .finally(() => setPending(undefined))
  }

  return (
    <main class="submission-page space-page">
      <SpacePageHeader eyebrow="个人空间" title="回收站" description="删除的个人 Skill 可在永久删除前恢复。" action={<></>} />
      <Show when={error()}>{(message) => <div class="submission-form__errors" role="alert">{message()}</div>}</Show>
      <Switch>
        <Match when={trash.isPending}>
          <section class="submission-state space-page__state" role="status">正在加载回收站…</section>
        </Match>
        <Match when={trash.error}>
          <section class="submission-state space-page__state" role="alert">
            <h2>回收站加载失败</h2>
            <button type="button" onClick={() => void trash.refetch()}>重新加载</button>
          </section>
        </Match>
        <Match when={trash.data}>
          {(items) => (
            <Show
              when={items().length > 0}
              fallback={<section class="submission-state space-page__state"><h2>回收站为空</h2></section>}
            >
              <section class="submission-list" aria-label="个人 Skill 回收站">
                <For each={items()}>
                  {(item) => {
                    const recoverable = () => new Date(item.purgeAfter).getTime() > Date.now()
                    return (
                      <article class="submission-card">
                        <div class="submission-card__main">
                          <div class="submission-card__title"><h2>{item.skillID}</h2><span>{item.targetVersion}</span></div>
                          <small>删除时间 {formatDate(item.deletedAt)}</small>
                          <small>永久删除时间 {formatDate(item.purgeAfter)} · {recoverable() ? remaining(item.purgeAfter) : "已超过恢复期限"}</small>
                        </div>
                        <div class="submission-card__actions">
                          <Show when={recoverable()}>
                            <button type="button" class="market-primary-action" disabled={Boolean(pending())} onClick={() => restore(item)}>
                              {pending() === item.id ? "正在恢复…" : "恢复个人 Skill"}
                            </button>
                          </Show>
                        </div>
                      </article>
                    )
                  }}
                </For>
              </section>
            </Show>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function remaining(value: string) {
  const milliseconds = new Date(value).getTime() - Date.now()
  const days = Math.ceil(milliseconds / 86_400_000)
  return `剩余 ${Math.max(days, 0)} 天`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}

function createIdempotencyKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
