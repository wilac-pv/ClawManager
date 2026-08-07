import { A } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { AnnouncementSource } from "../data-source"

const DISMISS_KEY = "skillhub:announcement:dismissed"

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []
  } catch {
    return []
  }
}

function saveDismissed(ids: string[]) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(ids))
  } catch {
    // ignore
  }
}

export function AnnouncementCarousel(props: { readonly source: AnnouncementSource }) {
  const announcements = createQuery(() => ({
    queryKey: ["skill-market", "announcements", "carousel"] as const,
    queryFn: ({ signal }) => props.source.list({ page: 1, limit: 5 }, signal),
    staleTime: 60_000,
  }))
  const [index, setIndex] = createSignal(0)
  const [dismissed, setDismissed] = createSignal<string[]>([])
  onMount(() => setDismissed(readDismissed()))

  const items = () => announcements.data?.items.filter((item) => !dismissed().includes(item.id)) ?? []
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

  const dismiss = (id: string) => {
    const next = [...dismissed(), id]
    setDismissed(next)
    saveDismissed(next)
  }

  return (
    <Show when={current()}>
      {(announcement) => (
        <section class="announcement-carousel" aria-label="最新公告" aria-roledescription="走马灯">
          <span class="announcement-carousel__badge type-badge">最新通知</span>
          <A class="announcement-carousel__content" href={`/announcements/${announcement().id}`}>
            <span class="announcement-carousel__text">{announcement().title}</span>
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
            <button
              type="button"
              class="announcement-carousel__close"
              aria-label="关闭此公告"
              onClick={() => dismiss(announcement().id)}
            >
              ×
            </button>
          </div>
        </section>
      )}
    </Show>
  )
}
