import { afterEach, beforeEach, expect, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { DesktopSkillMarketProvider } from "./desktop-provider"
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

const communitySkill = {
  ...codeReview,
  id: "safe-community-skill",
  source: "community",
  sourceUrl: "https://market.example.com/skills/community/safe-community-skill",
  name: "Community Review",
  submittedBy: { displayName: "如影用户" },
  reviewedAt: "2026-07-15T02:00:00.000Z",
} satisfies SkillMarket.Summary

const facets = {
  revision: "revision-1",
  sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
  sources: [
    { value: "skillhub", count: 1 },
    { value: "enterprise", count: 2 },
    { value: "community", count: 1 },
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
    prompt: () => "",
    copyPrompt: async () => undefined,
    download: async () => undefined,
  },
  installedOnly = false,
  onSubmit?: () => void,
  submitHref?: string,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const content = () => (
    <SkillMarketList
      onOpen={onOpen}
      installedOnly={installedOnly}
      onSubmit={onSubmit}
      submitHref={submitHref}
    />
  )
  return render(() => (
    <QueryClientProvider client={client}>
      <SkillMarketProvider source={source} actions={actions}>
        {actions.kind === "desktop" ? <DesktopSkillMarketProvider>{content()}</DesktopSkillMarketProvider> : content()}
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
    return page([codeReview], { skillhub: "stale", enterprise: "unavailable", community: "fresh" })
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

test("filters community skills and exposes the optional submission action", async () => {
  const calls: SkillMarket.PageQuery[] = []
  const opened: SkillKey[] = []
  let submitted = 0
  const view = renderMarket(
    dataSource(async (query) => {
      calls.push(query)
      return page([communitySkill])
    }),
    (key) => opened.push(key),
    undefined,
    false,
    () => submitted++,
  )

  expect(await view.findByRole("button", { name: "用户投稿" })).toBeTruthy()
  await userEvent.click(view.getByRole("button", { name: "用户投稿" }))
  await waitFor(() => expect(calls.at(-1)?.source).toBe("community"))
  await userEvent.click(view.getByRole("button", { name: "投稿 Skill" }))
  await userEvent.click(view.getByRole("button", { name: /Community Review/ }))

  expect(submitted).toBe(1)
  expect(opened).toEqual([{ source: "community", id: "safe-community-skill" }])
})

test("prefers a submission link while preserving callback-only actions", async () => {
  let submitted = 0
  const linked = renderMarket(
    dataSource(async () => page([communitySkill])),
    () => undefined,
    undefined,
    false,
    () => submitted++,
    "/ai-coding/ruying-code/skill-market/submissions/new",
  )
  const link = await linked.findByRole("link", { name: "投稿 Skill" })
  expect(link.getAttribute("href")).toBe("/ai-coding/ruying-code/skill-market/submissions/new")
  expect(submitted).toBe(0)
  cleanup()

  const callback = renderMarket(
    dataSource(async () => page([communitySkill])),
    () => undefined,
    undefined,
    false,
    () => submitted++,
  )
  await userEvent.click(await callback.findByRole("button", { name: "投稿 Skill" }))
  expect(submitted).toBe(1)
})

test("hides the submission action when no handler is provided", async () => {
  const view = renderMarket(dataSource(async () => page([codeReview])))

  await view.findByRole("button", { name: /Code Review/ })
  expect(view.queryByRole("button", { name: "投稿 Skill" })).toBeNull()
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
  expect(calls).toEqual(["refresh:gwm-review"])
  await userEvent.click(view.getByRole("button", { name: "确认卸载" }))

  await waitFor(() => expect(calls).toEqual(["refresh:gwm-review", "uninstall:gwm-review"]))
  expect(listCalls).toBe(0)
})
