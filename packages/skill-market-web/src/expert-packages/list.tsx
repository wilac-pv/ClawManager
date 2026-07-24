import type { SkillMarketDataSource } from "@opencode-ai/app/skill-market"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { A } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Show, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

type ExpertPackageSource = NonNullable<SkillMarketDataSource["expertPackages"]>

const scenes = [
  ["tech", "科技"],
  ["finance", "金融"],
  ["design", "设计"],
  ["marketing", "营销"],
  ["legal", "法律"],
  ["academic", "学术"],
  ["education", "教育"],
  ["hr", "人力"],
  ["ecommerce", "电商"],
  ["media", "媒体"],
  ["healthcare", "医疗"],
  ["lifestyle", "生活"],
  ["content-creation", "内容创作"],
  ["mysticism", "传统文化"],
] as const satisfies ReadonlyArray<readonly [SkillMarket.ExpertPackageScene, string]>

export function ExpertPackageList(props: { source: ExpertPackageSource }) {
  const [state, setState] = createStore({
    search: "",
    debounced: "",
    scene: "" as SkillMarket.ExpertPackageScene | "",
    page: 1,
  })
  createEffect(() => {
    const value = state.search
    const timer = window.setTimeout(() => setState({ debounced: value, page: 1 }), 300)
    onCleanup(() => window.clearTimeout(timer))
  })
  const result = createQuery(() => ({
    queryKey: ["skill-market", "expert-packages", state.debounced, state.scene, state.page] as const,
    queryFn: ({ signal }) =>
      props.source.list(
        {
          query: state.debounced.trim() || undefined,
          scene: state.scene || undefined,
          page: state.page,
          limit: 30,
        },
        signal,
      ),
  }))
  const available = () => new Set(result.data?.scenes.map((entry) => entry.value))
  return (
    <main class="expert-packages">
      <header class="market-section-hero expert-packages__hero">
        <span>EXPERT WORKFLOWS</span>
        <h1>专家包</h1>
        <p>
          快速发现专家能力组合，让 AI 从单点技能走向完整工作流
          <Show when={result.data}> · 共 {result.data?.total} 个专家包</Show>
        </p>
        <label>
          <span class="market-sr-only">搜索专家包</span>
          <input
            type="search"
            value={state.search}
            placeholder="搜索专家包"
            onInput={(event) => setState("search", event.currentTarget.value)}
          />
        </label>
      </header>
      <nav class="expert-packages__scenes" aria-label="专家包分类">
        <button
          type="button"
          aria-pressed={!state.scene}
          classList={{ "is-active": !state.scene }}
          onClick={() => setState({ scene: "", page: 1 })}
        >
          全部
        </button>
        <For each={scenes.filter(([value]) => available().has(value))}>
          {([value, label]) => (
            <button
              type="button"
              aria-pressed={state.scene === value}
              classList={{ "is-active": state.scene === value }}
              onClick={() => setState({ scene: value, page: 1 })}
            >
              {label}
            </button>
          )}
        </For>
      </nav>
      <Show when={result.isPending}>
        <div class="market-placeholder" role="status">
          正在加载专家包…
        </div>
      </Show>
      <Show when={result.isError}>
        <div class="market-placeholder" role="alert">
          专家包暂时无法访问，请稍后重试。
        </div>
      </Show>
      <Show when={!result.isPending && !result.isError && (result.data?.items.length ?? 0) === 0}>
        <div class="market-placeholder">没有找到匹配的专家包。</div>
      </Show>
      <div class="expert-packages__grid">
        <For each={result.data?.items ?? []}>
          {(entry) => (
            <A class="expert-package-card" href={`/expert-packages/${entry.slug}`}>
              <div class="expert-package-card__icon">{entry.displayName.trim().charAt(0)}</div>
              <div>
                <span>{sceneLabel(entry.scene)}</span>
                <h2>{entry.displayName}</h2>
                <strong>{expertLabel(entry.scene)}</strong>
                <p>{entry.summary}</p>
                <small>{entry.skillCount} 个 Skill 模块</small>
              </div>
              <span aria-hidden="true">→</span>
            </A>
          )}
        </For>
      </div>
      <Show when={(result.data?.total ?? 0) > 30}>
        <div class="expert-packages__pagination">
          <button type="button" disabled={state.page === 1} onClick={() => setState("page", state.page - 1)}>
            上一页
          </button>
          <span>第 {state.page} 页</span>
          <button
            type="button"
            disabled={state.page * 30 >= (result.data?.total ?? 0)}
            onClick={() => setState("page", state.page + 1)}
          >
            下一页
          </button>
        </div>
      </Show>
    </main>
  )
}

export function sceneLabel(scene: SkillMarket.ExpertPackageScene) {
  return scenes.find(([value]) => value === scene)?.[1] ?? scene
}

export function expertLabel(scene: SkillMarket.ExpertPackageScene) {
  return {
    academic: "学术研究专家",
    "content-creation": "内容创作专家",
    design: "产品设计顾问",
    ecommerce: "电商运营专家",
    education: "学习规划师",
    finance: "投资分析专家",
    healthcare: "健康信息顾问",
    hr: "组织人才顾问",
    legal: "法律合规顾问",
    lifestyle: "生活方式顾问",
    marketing: "营销增长专家",
    media: "媒体内容专家",
    mysticism: "传统文化顾问",
    tech: "高级开发工程师",
  }[scene]
}
