import { A } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Match, Show, Switch } from "solid-js"
import type { AnnouncementSource } from "../data-source"

export function AnnouncementDetail(props: { readonly announcementID: string; readonly source: AnnouncementSource }) {
  const detail = createQuery(() => ({
    queryKey: ["skill-market", "announcement", props.announcementID] as const,
    queryFn: ({ signal }) => props.source.detail(props.announcementID, signal),
  }))
  const history = createQuery(() => ({
    queryKey: ["skill-market", "announcements", "detail-history"] as const,
    queryFn: ({ signal }) => props.source.list({ page: 1, limit: 10 }, signal),
  }))

  return (
    <main class="announcement-page announcement-detail">
      <Switch>
        <Match when={detail.isPending}>
          <section class="submission-state" role="status">
            正在加载公告…
          </section>
        </Match>
        <Match when={detail.error}>
          <section class="submission-state" role="alert">
            <h1 class="type-page-title">公告暂不可用</h1>
            <p class="type-body">该公告不存在，或服务暂时无法访问。</p>
            <A href="/announcements">返回公告中心</A>
          </section>
        </Match>
        <Match when={detail.data}>
          {(announcement) => (
            <div class="announcement-detail__layout">
              <article class="announcement-detail__article">
                <A class="announcement-detail__back" href="/announcements">
                  ← 公告中心
                </A>
                <h1 class="type-page-title">{announcement().title}</h1>
                <time class="type-secondary" datetime={announcement().publishedAt}>{formatDate(announcement().publishedAt)}</time>
                <p class="announcement-detail__summary type-body">{announcement().summary}</p>
                <div class="announcement-detail__body type-body">
                  <AnnouncementContent value={announcement().content} />
                </div>
              </article>

              <aside class="announcement-detail__history">
                <header>
                  <h2 class="type-section-title">历史公告</h2>
                  <A href="/announcements">查看全部</A>
                </header>
                <Show when={history.data}>
                  {(result) => (
                    <nav aria-label="历史公告">
                      <For each={result().items}>
                        {(item) => (
                          <A
                            href={`/announcements/${item.id}`}
                            classList={{ "is-active": item.id === props.announcementID }}
                          >
                            <strong class="type-card-title">{item.title}</strong>
                            <time class="type-secondary" datetime={item.publishedAt}>{formatShortDate(item.publishedAt)}</time>
                          </A>
                        )}
                      </For>
                    </nav>
                  )}
                </Show>
              </aside>
            </div>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function AnnouncementContent(props: { readonly value: string }) {
  const lines = () => props.value.split(/\r?\n/).filter((line) => line.trim())
  return (
    <div class="ruying-skill-market__markdown">
      <For each={lines()}>
        {(line) =>
          line.startsWith("### ") ? (
            <h3 class="type-card-title">{line.slice(4)}</h3>
          ) : line.startsWith("## ") ? (
            <h2 class="type-section-title">{line.slice(3)}</h2>
          ) : line.startsWith("# ") ? (
            <h2 class="type-section-title">{line.slice(2)}</h2>
          ) : line.startsWith("- ") ? (
            <p class="type-body">• {line.slice(2)}</p>
          ) : (
            <p class="type-body">{line.replace(/\*\*/g, "")}</p>
          )
        }
      </For>
    </div>
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeStyle: "short" }).format(new Date(value))
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value))
}
