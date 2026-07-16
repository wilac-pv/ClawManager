import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createSkillMarketControlDataSource } from "./control-data-source"
import { SkillMarketSessionProvider } from "./session"
import { MarketShell } from "./shell"

const csrfToken = "c".repeat(43)

afterEach(() => cleanup())

describe("market shell", () => {
  test("shows public navigation and a login action for anonymous users", async () => {
    const fixture = renderShell(null, "/skills")

    expect((await fixture.view.findByRole("link", { name: "Skill 市场" })).getAttribute("aria-current")).toBe("page")
    expect(fixture.view.queryByRole("link", { name: "我的投稿" })).toBeNull()
    expect(fixture.view.queryByRole("link", { name: "管理后台" })).toBeNull()
    fireEvent.click(await fixture.view.findByRole("button", { name: "使用 GWM SSO 登录" }))
    expect(fixture.navigations).toEqual(["http://127.0.0.1:4210/v1/auth/login?returnTo=%2Fskills"])
  })

  test("shows a compact two-line identity and submission navigation for a contributor", async () => {
    const fixture = renderShell(session([]), "/submissions")

    expect((await fixture.view.findByRole("link", { name: "我的投稿" })).getAttribute("aria-current")).toBe("page")
    expect(fixture.view.getByText("Contributor User").getAttribute("data-identity-name")).not.toBeNull()
    expect(fixture.view.getByText("E000001").getAttribute("data-identity-id")).not.toBeNull()
    expect(fixture.view.queryByRole("link", { name: "管理后台" })).toBeNull()
    expect(fixture.view.getByRole("button", { name: "退出登录" })).toBeTruthy()
  })

  test("shows review navigation to Reviewer and full controls only to Admin", async () => {
    const reviewer = renderShell(session(["reviewer"]), "/admin")
    expect((await reviewer.view.findByRole("link", { name: "管理后台" })).getAttribute("aria-current")).toBe("page")
    expect(reviewer.view.queryByRole("link", { name: "角色管理" })).toBeNull()
    expect(reviewer.view.queryByRole("link", { name: "审计日志" })).toBeNull()
    cleanup()

    const admin = renderShell(session(["admin"]), "/admin/roles")
    expect(await admin.view.findByRole("link", { name: "管理后台" })).toBeTruthy()
    expect(admin.view.getByRole("link", { name: "角色管理" }).getAttribute("aria-current")).toBe("page")
    expect(admin.view.getByRole("link", { name: "审计日志" })).toBeTruthy()
  })
})

function renderShell(sessionState: SkillMarketControl.SessionState, path: string) {
  const navigations: string[] = []
  const source = createSkillMarketControlDataSource("http://127.0.0.1:4210", {
    csrfToken: () => sessionState?.csrfToken,
    fetcher: () => Promise.resolve(Response.json(sessionState)),
  })
  const history = createMemoryHistory()
  history.set({ value: path, replace: true })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const view = render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => (
            <SkillMarketSessionProvider source={source} navigate={(url) => navigations.push(url)}>
              <MarketShell>
                <div>Page content</div>
              </MarketShell>
            </SkillMarketSessionProvider>
          )}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ))
  return { view, navigations }
}

function session(roles: SkillMarketControl.Role[]): SkillMarketControl.Session {
  return {
    user: { employeeID: "E000001", displayName: "Contributor User" },
    roles,
    csrfToken,
    createdAt: "2026-07-16T00:00:00.000Z",
    absoluteExpiresAt: "2026-07-16T12:00:00.000Z",
    idleExpiresAt: "2026-07-16T02:00:00.000Z",
  }
}
