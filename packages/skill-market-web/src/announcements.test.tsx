import { afterEach, expect, test } from "bun:test"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { JSX } from "solid-js"
import { AnnouncementCarousel } from "./announcements/carousel"
import { AnnouncementDetail } from "./announcements/detail"
import { AnnouncementHistory } from "./announcements/history"
import type { AnnouncementSource } from "./data-source"

const announcements = [
  {
    id: "ann_abcdefgh",
    title: "Skill 市场新功能上线",
    summary: "专家包和收藏功能现已开放。",
    content: "# 新功能\n\n欢迎使用专家包和收藏功能。",
    publishedAt: "2026-07-24T00:00:00.000Z",
  },
  {
    id: "ann_ijklmnop",
    title: "服务维护通知",
    summary: "本周末将进行短时维护。",
    content: "# 维护通知\n\n预计持续十分钟。",
    publishedAt: "2026-07-23T00:00:00.000Z",
  },
] satisfies SkillMarket.AnnouncementDetail[]

const source = {
  list: async (query) => ({
    total: announcements.length,
    page: query.page,
    limit: query.limit,
    items: announcements,
  }),
  detail: async (announcementID) => announcements.find((item) => item.id === announcementID)!,
} satisfies AnnouncementSource

afterEach(() => cleanup())

test("shows the latest announcement as a carousel and switches announcements", async () => {
  const view = renderPage(() => <AnnouncementCarousel source={source} />)

  expect(await view.findByRole("link", { name: /Skill 市场新功能上线/ })).toBeTruthy()
  expect(view.getByText("公告").classList).toContain("type-badge")
  fireEvent.click(view.getByRole("button", { name: /查看公告 2/ }))
  expect(view.getByRole("link", { name: /服务维护通知/ }).getAttribute("href")).toBe(
    "/announcements/ann_ijklmnop",
  )
  expect(view.getByRole("link", { name: "历史公告" }).getAttribute("href")).toBe("/announcements")
})

test("renders announcement history and detail with the historical sidebar", async () => {
  const history = renderPage(() => <AnnouncementHistory source={source} />)
  expect(await history.findByRole("heading", { name: "公告中心", level: 1 })).toBeTruthy()
  expect(history.getByRole("heading", { name: "公告中心", level: 1 }).classList).toContain("type-page-title")
  expect(history.container.textContent).not.toContain("Ruying SkillHub updates")
  expect(await history.findByRole("link", { name: /Skill 市场新功能上线/ })).toBeTruthy()
  cleanup()

  const detail = renderPage(() => <AnnouncementDetail announcementID="ann_abcdefgh" source={source} />)
  expect(await detail.findByRole("heading", { name: "Skill 市场新功能上线", level: 1 })).toBeTruthy()
  expect(detail.getByRole("heading", { name: "Skill 市场新功能上线", level: 1 }).classList).toContain("type-page-title")
  expect(detail.container.textContent).not.toContain("Announcement")
  expect(detail.getByRole("heading", { name: "新功能" })).toBeTruthy()
  expect(detail.getByRole("navigation", { name: "历史公告" })).toBeTruthy()
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
