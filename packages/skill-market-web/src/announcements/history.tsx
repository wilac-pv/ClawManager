import { A } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Match, Show, Switch, createSignal } from "solid-js"
import type { AnnouncementSource } from "../data-source"

export function AnnouncementHistory(props: { readonly source: AnnouncementSource }) {
  const [page, setPage] = createSignal(1)
  const announcements = createQuery(() => ({
    queryKey: ["skill-market", "announcements", "history", page()] as const,
    queryFn: ({ signal }) => props.source.list({ page: page(), limit: 20 }, signal),
  }))

  return (
    <main class="announcement-page">
      <header class="announcement-page__heading">
        <div>
          <p class="submission-page__eyebrow">Ruying SkillHub updates</p>
          <h1>公告中心</h1>
          <p>查看 Skill 市场的功能发布、服务调整和运营通知。</p>
        </div>
      </header>

      <Switch>
        <Match when={announcements.isPending}>
          <section class="submission-state" role="status">
            正在加载公告…
          </section>
        </Match>
        <Match when={announcements.error}>
          <section class="submission-state" role="alert">
            <h2>公告加载失败</h2>
            <button type="button" onClick={() => void announcements.refetch()}>
              重新加载
            </button>
          </section>
        </Match>
        <Match when={announcements.data}>
          {(result) => (
            <>
              <Show
                when={result().items.length > 0}
                fallback={
                  <section class="submission-state">
                    <h2>暂无公告</h2>
                    <p>管理员发布后会显示在这里。</p>
                  </section>
                }
              >
                <section class="announcement-history" aria-label="历史公告">
                  <For each={result().items}>
                    {(announcement) => (
                      <A class="announcement-history__item" href={`/announcements/${announcement.id}`}>
                        <time datetime={announcement.publishedAt}>{formatDate(announcement.publishedAt)}</time>
                        <div>
                          <h2>{announcement.title}</h2>
                          <p>{announcement.summary}</p>
                        </div>
                        <span aria-hidden="true">→</span>
                      </A>
                    )}
                  </For>
                </section>
              </Show>
              <nav class="announcement-pagination" aria-label="公告分页">
                <button type="button" disabled={page() === 1} onClick={() => setPage((value) => value - 1)}>
                  上一页
                </button>
                <span>
                  第 {page()} 页 · 共 {result().total} 条
                </span>
                <button
                  type="button"
                  disabled={page() * result().limit >= result().total}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </button>
              </nav>
            </>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(new Date(value))
}
