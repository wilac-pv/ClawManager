import { A } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { AnnouncementSource } from "../data-source"

export function AnnouncementCarousel(props: { readonly source: AnnouncementSource }) {
  const announcements = createQuery(() => ({
    queryKey: ["skill-market", "announcements", "carousel"] as const,
    queryFn: ({ signal }) => props.source.list({ page: 1, limit: 5 }, signal),
    staleTime: 60_000,
  }))
  const [index, setIndex] = createSignal(0)
  const items = () => announcements.data?.items ?? []
  const current = () => items()[index()]

  createEffect(() => {
    if (index() >= items().length) setIndex(0)
  })
  onMount(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const timer = window.setInterval(() => {
      if (items().length > 1) setIndex((value) => (value + 1) % items().length)
    }, 6_000)
    onCleanup(() => window.clearInterval(timer))
  })

  return (
    <Show when={current()}>
      {(announcement) => (
        <section class="announcement-carousel" aria-label="最新公告" aria-roledescription="走马灯">
          <span class="announcement-carousel__badge type-badge">公告</span>
          <A class="announcement-carousel__content" href={`/announcements/${announcement().id}`}>
            <strong class="type-card-title">{announcement().title}</strong>
            <span class="type-secondary">{announcement().summary}</span>
          </A>
          <div class="announcement-carousel__controls">
            <div class="announcement-carousel__dots" aria-label="公告切换">
              <For each={items()}>
                {(item, itemIndex) => (
                  <button
                    type="button"
                    aria-label={`查看公告 ${itemIndex() + 1}：${item.title}`}
                    aria-current={itemIndex() === index() ? "true" : undefined}
                    onClick={() => setIndex(itemIndex())}
                  />
                )}
              </For>
            </div>
            <A href="/announcements">历史公告</A>
          </div>
        </section>
      )}
    </Show>
  )
}
