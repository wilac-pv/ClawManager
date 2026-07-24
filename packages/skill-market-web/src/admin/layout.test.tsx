import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createSkillMarketControlDataSource } from "../control-data-source"
import { SkillMarketSessionProvider } from "../session"
import { AdminLayout } from "./layout"

const csrfToken = "c".repeat(43)

afterEach(() => cleanup())

describe("admin layout", () => {
  test("shows only review navigation to Reviewer", async () => {
    const view = renderLayout(session(["reviewer"]), "/admin")

    expect((await view.findByRole("link", { name: "投稿审核" })).classList.contains("is-active")).toBe(true)
    expect(view.queryByRole("link", { name: "角色管理" })).toBeNull()
    expect(view.getByText("审核员")).toBeTruthy()
  })

  test("shows all management sections to Admin and keeps review detail active", async () => {
    const view = renderLayout(session(["admin"]), "/admin/submissions/sub_abcdefgh")

    expect((await view.findByRole("link", { name: "投稿审核" })).classList.contains("is-active")).toBe(true)
    expect(view.getByRole("link", { name: "角色管理" })).toBeTruthy()
    expect(view.getByRole("link", { name: "审计日志" })).toBeTruthy()
    expect(view.getByRole("link", { name: "SkillHub 同步" })).toBeTruthy()
    expect(view.getByRole("link", { name: "公告发布" })).toBeTruthy()
    expect(view.getByText("管理员")).toBeTruthy()
  })

  test("marks the selected Admin section active", async () => {
    const view = renderLayout(session(["admin"]), "/admin/announcements")

    expect((await view.findByRole("link", { name: "公告发布" })).classList.contains("is-active")).toBe(true)
    expect(view.getByRole("link", { name: "投稿审核" }).classList.contains("is-active")).toBe(false)
  })
})

function renderLayout(sessionState: SkillMarketControl.Session, path: string) {
  const source = createSkillMarketControlDataSource("http://127.0.0.1:4210", {
    csrfToken: () => sessionState.csrfToken,
    fetcher: () => Promise.resolve(Response.json(sessionState)),
  })
  const history = createMemoryHistory()
  history.set({ value: path, replace: true })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => (
            <SkillMarketSessionProvider source={source}>
              <AdminLayout>
                <div>管理内容</div>
              </AdminLayout>
            </SkillMarketSessionProvider>
          )}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ))
}

function session(roles: SkillMarketControl.Role[]): SkillMarketControl.Session {
  return {
    user: { employeeID: "E000001", displayName: "Admin User" },
    roles,
    csrfToken,
    createdAt: "2026-07-16T00:00:00.000Z",
    absoluteExpiresAt: "2026-07-16T12:00:00.000Z",
    idleExpiresAt: "2026-07-16T02:00:00.000Z",
  }
}
