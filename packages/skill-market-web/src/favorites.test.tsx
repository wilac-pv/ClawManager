import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render } from "@solidjs/testing-library"
import type { SkillMarketDataSource } from "@opencode-ai/app/skill-market"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createSkillMarketControlDataSource } from "./control-data-source"
import { FavoritesPage } from "./favorites"
import { SkillMarketSessionProvider } from "./session"

const csrfToken = "c".repeat(43)

afterEach(() => cleanup())

describe("favorites page", () => {
  test("uses the shared space page header and empty state", async () => {
    const view = renderFavorites(() => Promise.resolve([]))

    expect(await view.findByRole("heading", { name: "还没有收藏 Skill" })).toBeTruthy()
    expect(view.getByRole("heading", { name: "我的收藏" }).closest("header")?.className).toBe("space-page__header")
    expect(view.getByRole("link", { name: "浏览 Skill 市场" }).getAttribute("href")).toBe("/skills")
    expect(view.getByRole("main").classList.contains("space-page")).toBe(true)
  })

  test("shows the same retryable error state as submission pages", async () => {
    const view = renderFavorites(() => Promise.reject(new Error("unavailable")))

    expect(await view.findByRole("heading", { name: "收藏加载失败" })).toBeTruthy()
    expect(view.getByRole("alert").className).toBe("space-page__state")
    expect(view.getByRole("button", { name: "重新加载" })).toBeTruthy()
  })
})

function renderFavorites(list: () => Promise<SkillMarket.Favorite[]>) {
  const session: SkillMarketControl.Session = {
    user: { employeeID: "E000001", displayName: "Contributor" },
    roles: [],
    csrfToken,
    createdAt: "2026-07-16T00:00:00.000Z",
    absoluteExpiresAt: "2026-07-16T12:00:00.000Z",
    idleExpiresAt: "2026-07-16T02:00:00.000Z",
  }
  const source = createSkillMarketControlDataSource("http://127.0.0.1:4210", {
    csrfToken: () => csrfToken,
    fetcher: (input) => {
      const pathname = new URL(input instanceof Request ? input.url : input).pathname
      if (pathname === "/v1/auth/session") return Promise.resolve(Response.json(session))
      if (pathname === "/v1/favorites") return list().then((items) => Response.json(items))
      return Promise.reject(new Error("unexpected request"))
    },
  })
  const history = createMemoryHistory()
  history.set({ value: "/favorites", replace: true })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => (
            <SkillMarketSessionProvider source={source}>
              <FavoritesPage source={source.favorites} catalog={catalog} />
            </SkillMarketSessionProvider>
          )}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ))
}

const unavailable = () => Promise.reject(new Error("unused catalog method"))
const catalog: SkillMarketDataSource = {
  list: unavailable,
  facets: unavailable,
  detail: unavailable,
  versions: unavailable,
}
