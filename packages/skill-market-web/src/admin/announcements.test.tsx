import { afterEach, expect, test } from "bun:test"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { Route, Router } from "@solidjs/router"
import { AnnouncementAdministration } from "./announcements"

afterEach(() => cleanup())

test("validates and publishes an immutable announcement", async () => {
  const calls: unknown[] = []
  const view = render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <AnnouncementAdministration
            source={{
              async publish(input) {
                calls.push(input)
                return {
                  id: "ann_abcdefgh",
                  ...input,
                  publishedAt: "2026-07-24T00:00:00.000Z",
                }
              },
            }}
          />
        )}
      />
    </Router>
  ))

  expect(view.getByRole("heading", { name: "公告发布", level: 1 }).classList).toContain("type-page-title")
  expect(view.container.textContent).not.toContain("Admin workspace")
  fireEvent.submit(view.getByRole("button", { name: "立即发布公告" }).closest("form")!)
  expect(view.getByRole("alert").textContent).toContain("请完整填写")

  fireEvent.input(view.getByLabelText("公告标题"), { target: { value: "新功能上线" } })
  fireEvent.input(view.getByLabelText("首页摘要"), { target: { value: "公告摘要" } })
  fireEvent.input(view.getByLabelText("公告正文"), { target: { value: "# 公告正文" } })
  fireEvent.click(view.getByRole("button", { name: "立即发布公告" }))

  expect(await view.findByText("公告已发布")).toBeTruthy()
  expect(calls).toEqual([{ title: "新功能上线", summary: "公告摘要", content: "# 公告正文" }])
  expect(view.getByRole("link", { name: "查看公告详情" }).getAttribute("href")).toBe(
    "/announcements/ann_abcdefgh",
  )
})
