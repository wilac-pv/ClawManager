import type {
  SkillFavoriteActions,
  SkillKey,
  SkillMarketDataSource,
} from "@opencode-ai/app/skill-market"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { A, useLocation } from "@solidjs/router"
import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Match, Show, Switch } from "solid-js"
import type { SkillMarketControlDataSource } from "./control-data-source"
import { useSkillMarketSession } from "./session"
import { SpacePageHeader } from "./space/page"

const favoriteQueryKey = ["skill-market", "favorites"] as const

export function useFavoriteActions(source: SkillMarketControlDataSource["favorites"]): SkillFavoriteActions {
  const session = useSkillMarketSession()
  const location = useLocation()
  const client = useQueryClient()
  const favorites = createQuery(() => ({
    queryKey: favoriteQueryKey,
    queryFn: ({ signal }) => source.list(signal),
    enabled: Boolean(session.session()),
    retry: false,
  }))
  const mutation = createMutation(() => ({
    mutationFn: async (input: { key: SkillKey; active: boolean }) => {
      if (input.active) return source.remove(input.key.source, input.key.id)
      return source.add(input.key.source, input.key.id)
    },
    onSuccess: () => client.invalidateQueries({ queryKey: favoriteQueryKey }),
  }))
  const matches = (left: SkillKey, right: SkillKey) => left.source === right.source && left.id === right.id
  return {
    active: (key) => favorites.data?.some((entry) => matches(entry, key)) ?? false,
    pending: (key) => mutation.isPending && Boolean(mutation.variables && matches(mutation.variables.key, key)),
    toggle: (key) => {
      if (!session.session()) {
        session.login(`${location.pathname}${location.search}`)
        return
      }
      mutation.mutate({ key, active: favorites.data?.some((entry) => matches(entry, key)) ?? false })
    },
  }
}

export function FavoritesPage(props: {
  source: SkillMarketControlDataSource["favorites"]
  catalog: SkillMarketDataSource
}) {
  const favorites = createQuery(() => ({
    queryKey: favoriteQueryKey,
    queryFn: ({ signal }) => props.source.list(signal),
  }))
  const actions = useFavoriteActions(props.source)
  return (
    <main class="favorite-page space-page">
      <SpacePageHeader
        eyebrow="收藏内容"
        title="我的收藏"
        description="收藏的 Skill 会跟随当前 GWM SSO 账号，在不同设备上保持一致。"
        action={
          <A class="market-primary-action" href="/skills">
            浏览 Skill 市场
          </A>
        }
      />
      <Switch>
        <Match when={favorites.isPending}>
          <section class="space-page__state" role="status">
            正在加载收藏…
          </section>
        </Match>
        <Match when={favorites.error}>
          <section class="space-page__state" role="alert">
            <h2 class="type-section-title">收藏加载失败</h2>
            <p class="type-body">请检查网络后重试。</p>
            <button type="button" onClick={() => void favorites.refetch()}>
              重新加载
            </button>
          </section>
        </Match>
        <Match when={favorites.data}>
          {(items) => (
            <Show
              when={items().length > 0}
              fallback={
                <section class="space-page__state">
                  <h2 class="type-section-title">还没有收藏 Skill</h2>
                  <p class="type-body">在市场卡片或 Skill 详情页点击星标即可收藏。</p>
                </section>
              }
            >
              <section class="favorite-page__grid" aria-label="我的收藏列表">
                <For each={items()}>
                  {(favorite) => <FavoriteSkill favorite={favorite} catalog={props.catalog} actions={actions} />}
                </For>
              </section>
            </Show>
          )}
        </Match>
      </Switch>
    </main>
  )
}

function FavoriteSkill(props: {
  favorite: SkillMarket.Favorite
  catalog: SkillMarketDataSource
  actions: SkillFavoriteActions
}) {
  const detail = createQuery(() => ({
    queryKey: ["skill-market", "favorite-detail", props.favorite.source, props.favorite.id] as const,
    queryFn: ({ signal }) => props.catalog.detail(props.favorite, signal),
    retry: false,
  }))
  return (
    <article class="favorite-page__card">
      <Show when={detail.data} fallback={<span>{props.favorite.id}</span>}>
        {(skill) => (
          <>
            <div>
              <span class="favorite-page__source type-badge">
                {skill().source === "skillhub" ? "SkillHub" : skill().source === "enterprise" ? "企业精选" : "用户投稿"}
              </span>
              <h2 class="type-card-title">{skill().name}</h2>
              <p class="type-secondary">{skill().description}</p>
            </div>
            <div class="favorite-page__actions">
              <A href={`/skills/${skill().source}/${encodeURIComponent(skill().id)}`}>查看详情</A>
              <button type="button" onClick={() => props.actions.toggle(skill())}>
                取消收藏
              </button>
            </div>
          </>
        )}
      </Show>
    </article>
  )
}
