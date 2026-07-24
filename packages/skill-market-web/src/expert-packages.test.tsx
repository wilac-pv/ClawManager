import { afterEach, expect, test } from "bun:test"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import type { SkillMarketDataSource } from "@opencode-ai/app/skill-market"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { JSX } from "solid-js"
import { ExpertPackageDetail } from "./expert-packages/detail"
import { ExpertPackageList } from "./expert-packages/list"

const detail = {
  slug: "tech-test-automation",
  displayName: "自动化测试",
  summary: "覆盖单元测试、端到端测试和 API 测试的完整工作流。",
  scene: "tech",
  skillCount: 2,
  updatedAt: "2026-07-23T00:00:00.000Z",
  content: "# 自动化测试工作流\n\n按顺序使用每个 Skill。",
  skillSlugs: ["test-driven-development", "e2e-testing-patterns"],
} satisfies SkillMarket.ExpertPackageDetail

const source = {
  list: async () => ({
    total: 1,
    page: 1,
    limit: 30,
    items: [detail],
    scenes: [{ value: "tech", count: 1 }],
  }),
  detail: async () => detail,
} satisfies NonNullable<SkillMarketDataSource["expertPackages"]>

afterEach(() => cleanup())

test("renders searchable expert package cards and category filters", async () => {
  const view = renderPage(() => <ExpertPackageList source={source} />)

  expect(await view.findByRole("heading", { name: "专家包", level: 1 })).toBeTruthy()
  expect((await view.findByRole("link", { name: /自动化测试/ })).getAttribute("href")).toBe(
    "/expert-packages/tech-test-automation",
  )
  expect(view.getByRole("button", { name: "科技" })).toBeTruthy()
  fireEvent.input(view.getByRole("searchbox"), { target: { value: "测试" } })
  expect(view.getByRole<HTMLInputElement>("searchbox").value).toBe("测试")
})

test("renders expert workflow, child Skills, and an internal install prompt action", async () => {
  const view = renderPage(() => (
    <ExpertPackageDetail
      slug={detail.slug}
      source={source}
      detailUrl={(slug) => `http://10.246.13.226:4211/market/expert-packages/${slug}`}
    />
  ))

  expect(await view.findByRole("heading", { name: detail.displayName, level: 1 })).toBeTruthy()
  expect(view.getByRole("heading", { name: "自动化测试工作流" })).toBeTruthy()
  expect(view.getByRole("button", { name: "复制安装 Prompt" })).toBeTruthy()
  expect(view.getByRole("link", { name: "test-driven-development" }).getAttribute("href")).toContain(
    "/skills?q=test-driven-development",
  )
})

function renderPage(content: () => JSX.Element) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <Router>
        <Route path="*" component={content} />
      </Router>
    </QueryClientProvider>
  ))
}
