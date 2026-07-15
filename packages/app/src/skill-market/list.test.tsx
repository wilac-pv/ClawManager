import { afterEach, beforeEach, expect, test } from "bun:test"
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { SkillMarketList } from "./list"
import { SkillMarketProvider } from "./provider"
import type { SkillKey, SkillMarketActions, SkillMarketDataSource } from "./types"

const codeReview = {
  id: "code-review",
  source: "skillhub",
  sourceUrl: "https://skillhub.cn/skills/code-review",
  name: "Code Review",
  description: "审查代码并发现风险",
  iconUrl: "https://cdn.example.com/code-review.png",
  categories: ["代码质量"],
  tags: ["review"],
  requiresApiKey: false,
  risk: "safe",
  version: "1.2.0",
  updatedAt: "2026-07-15T01:00:00.000Z",
  downloads: 1200,
  favorites: 80,
  score: 98.6,
  featured: true,
  enterprise: false,
  delisted: false,
} satisfies SkillMarket.Summary

const facets = {
  revision: "revision-1",
  sourceStatus: { skillhub: "fresh", enterprise: "fresh" },
  sources: [
    { value: "skillhub", count: 1 },
    { value: "enterprise", count: 2 },
  ],
  categories: [{ value: "代码质量", count: 1 }],
  requiresApiKey: { yes: 2, no: 1 },
} satisfies SkillMarket.Facets

function page(items: SkillMarket.Summary[], sourceStatus: SkillMarket.SourceStatus = facets.sourceStatus) {
  return {
    revision: "revision-1",
    sourceStatus,
    total: items.length,
    page: 1,
    limit: 30,
    items,
  } satisfies SkillMarket.Page
}

function dataSource(list: SkillMarketDataSource["list"]): SkillMarketDataSource {
  return {
    list,
    facets: async () => facets,
    detail: async () => Promise.reject(new Error("unused")),
    versions: async () => [],
  }
}

function renderMarket(
  source: SkillMarketDataSource,
  onOpen: (key: SkillKey) => void = () => undefined,
  actions: SkillMarketActions = {
    kind: "web",
    copyPrompt: async () => undefined,
    download: async () => undefined,
  },
  installedOnly = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(() => (
    <QueryClientProvider client={client}>
      <SkillMarketProvider source={source} actions={actions}>
        <SkillMarketList onOpen={onOpen} installedOnly={installedOnly} />
      </SkillMarketProvider>
    </QueryClientProvider>
  ))
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(undefined, "", "/skills")
})

afterEach(() => {
  document.body.innerHTML = ""
})

test("debounces search, sends server filters and opens a skill", async () => {
  const calls: SkillMarket.PageQuery[] = []
  const source = dataSource(async (query) => {
    calls.push(query)
    return page([codeReview])
  })
  const opened: SkillKey[] = []
  const view = renderMarket(source, (key) => opened.push(key))

  await waitFor(() => expect(calls.length).toBeGreaterThan(0))
  await userEvent.type(view.getByRole("searchbox"), "review")
  await new Promise((resolve) => setTimeout(resolve, 350))
  await waitFor(() => expect(calls.at(-1)?.query).toBe("review"))
  await userEvent.selectOptions(view.getByLabelText("来源"), "enterprise")
  await waitFor(() => expect(calls.at(-1)?.source).toBe("enterprise"))
  await userEvent.click(await view.findByRole("button", { name: /Code Review/ }))

  expect(opened).toEqual([{ source: "skillhub", id: "code-review" }])
})

test("sorts and filters remotely while persisting the selected view", async () => {
  const calls: SkillMarket.PageQuery[] = []
  const source = dataSource(async (query) => {
    calls.push(query)
    return page([codeReview], { skillhub: "stale", enterprise: "unavailable" })
  })
  const view = renderMarket(source)

  await view.findByRole("button", { name: /Code Review/ })
  await userEvent.click(view.getByRole("button", { name: "下载量" }))
  await waitFor(() => expect(calls.at(-1)?.sort).toBe("downloads"))
  await userEvent.selectOptions(view.getByLabelText("API Key"), "no")
  await waitFor(() => expect(calls.at(-1)?.requiresApiKey).toBe(false))
  await userEvent.click(view.getByRole("button", { name: "列表视图" }))

  expect(localStorage.getItem("ruying-skill-market-view")).toBe("list")
  expect(view.getByRole("status").textContent).toContain("部分来源")
  expect(view.queryByRole("button", { name: "已安装" })).toBeNull()
  expect(view.queryByText("收藏")).toBeNull()
  expect(view.queryByText("评论")).toBeNull()

  const image = view.getByRole("img", { name: "Code Review 图标" })
  fireEvent.error(image)
  expect(view.getByLabelText("Code Review 默认图标").textContent).toBe("C")
})

test("renders a useful empty state and keyboard focus", async () => {
  const view = renderMarket(dataSource(async () => page([])))

  expect(await view.findByText("没有找到匹配的 Skill")).toBeTruthy()
  await userEvent.tab()
  expect(document.activeElement).toBe(view.getByRole("searchbox"))
})

test("manages installed skills offline without calling the catalog", async () => {
  let listCalls = 0
  const source: SkillMarketDataSource = {
    ...dataSource(async () => {
      listCalls++
      return page([codeReview])
    }),
    installed: async () => [
      {
        source: "enterprise",
        id: "gwm-review",
        name: "GWM Review",
        version: "2.0.0",
        installedAt: "2026-07-15T01:00:00.000Z",
        updateAvailable: false,
        loadState: "refresh-failed",
      },
    ],
    updates: async () => [],
  }
  const calls: string[] = []
  const actions: SkillMarketActions = {
    kind: "desktop",
    install: async () => Promise.reject(new Error("unused")),
    update: async () => Promise.reject(new Error("unused")),
    uninstall: async (key) => {
      calls.push(`uninstall:${key.id}`)
    },
    refresh: async (key) => {
      calls.push(`refresh:${key.id}`)
    },
  }
  const view = renderMarket(source, undefined, actions, true)

  expect(await view.findByText("GWM Review")).toBeTruthy()
  await userEvent.click(view.getByRole("button", { name: "重试加载 GWM Review" }))
  await userEvent.click(view.getByRole("button", { name: "卸载 GWM Review" }))

  expect(calls).toEqual(["refresh:gwm-review", "uninstall:gwm-review"])
  expect(listCalls).toBe(0)
})
