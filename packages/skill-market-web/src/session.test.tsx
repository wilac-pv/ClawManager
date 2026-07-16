import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { JSX } from "solid-js"
import { createSkillMarketControlDataSource } from "./control-data-source"
import {
  RequireAdmin,
  RequireReviewer,
  RequireSession,
  SkillMarketSessionProvider,
  safeReturnTo,
  useSkillMarketSession,
} from "./session"

const csrfToken = "c".repeat(43)
const contributor = session([])
const reviewer = session(["reviewer"])
const admin = session(["admin"])

afterEach(() => cleanup())

describe("skill market session", () => {
  test("keeps an anonymous protected route and starts full-page SSO with its safe return path", async () => {
    const fixture = renderSession(null, "/submissions/new", () => (
      <RequireSession>
        <div>Private submission form</div>
      </RequireSession>
    ))

    expect(await fixture.view.findByRole("button", { name: "使用 GWM SSO 登录" })).toBeTruthy()
    expect(fixture.view.queryByText("Private submission form")).toBeNull()
    fireEvent.click(fixture.view.getByRole("button", { name: "使用 GWM SSO 登录" }))

    expect(fixture.navigations).toEqual(["http://127.0.0.1:4210/v1/auth/login?returnTo=%2Fsubmissions%2Fnew"])
  })

  test("enforces Reviewer and Admin guards from server-returned roles", async () => {
    const contributorView = renderSession(contributor, "/admin", () => (
      <RequireReviewer>
        <div>Review queue</div>
      </RequireReviewer>
    )).view
    expect(await contributorView.findByRole("heading", { name: "没有访问权限" })).toBeTruthy()
    cleanup()

    const reviewerView = renderSession(reviewer, "/admin", () => (
      <>
        <RequireReviewer>
          <div>Review queue</div>
        </RequireReviewer>
        <RequireAdmin>
          <div>Role administration</div>
        </RequireAdmin>
      </>
    )).view
    expect(await reviewerView.findByText("Review queue")).toBeTruthy()
    expect(reviewerView.getByRole("heading", { name: "没有访问权限" })).toBeTruthy()
    expect(reviewerView.queryByText("Role administration")).toBeNull()
    cleanup()

    const adminView = renderSession(admin, "/admin/roles", () => (
      <>
        <RequireReviewer>
          <div>Review queue</div>
        </RequireReviewer>
        <RequireAdmin>
          <div>Role administration</div>
        </RequireAdmin>
      </>
    )).view
    expect(await adminView.findByText("Review queue")).toBeTruthy()
    expect(adminView.getByText("Role administration")).toBeTruthy()
  })

  test("refetches an expired session and clears it after logout", async () => {
    const fixture = renderSession(contributor, "/submissions", SessionProbe)

    expect(await fixture.view.findByText("signed-in:E000001")).toBeTruthy()
    fixture.state.value = null
    fireEvent.click(fixture.view.getByRole("button", { name: "Refetch session" }))
    expect(await fixture.view.findByText("anonymous")).toBeTruthy()

    fixture.state.value = contributor
    fireEvent.click(fixture.view.getByRole("button", { name: "Refetch session" }))
    expect(await fixture.view.findByText("signed-in:E000001")).toBeTruthy()
    fireEvent.click(fixture.view.getByRole("button", { name: "Log out" }))
    await waitFor(() => expect(fixture.view.getByText("anonymous")).toBeTruthy())
    expect(fixture.logoutCalls.value).toBe(1)
  })

  test("accepts only declared internal return routes", () => {
    expect(safeReturnTo("/skills/community/safe-skill")).toBe("/skills/community/safe-skill")
    expect(safeReturnTo("/submissions/sub_abcdefgh?tab=history")).toBe("/submissions/sub_abcdefgh?tab=history")
    expect(safeReturnTo("/admin/audit?page=2")).toBe("/admin/audit?page=2")
    expect(safeReturnTo("https://attacker.example/submissions")).toBe("/skills")
    expect(safeReturnTo("//attacker.example/admin")).toBe("/skills")
    expect(safeReturnTo("/unknown")).toBe("/skills")
  })
})

function SessionProbe() {
  const current = useSkillMarketSession()
  return (
    <div>
      <span>{current.session() ? `signed-in:${current.session()!.user.employeeID}` : "anonymous"}</span>
      <button type="button" onClick={() => void current.refetch()}>
        Refetch session
      </button>
      <button type="button" onClick={() => void current.logout()}>
        Log out
      </button>
    </div>
  )
}

function renderSession(initial: SkillMarketControl.SessionState, path: string, content: () => JSX.Element) {
  const state: { value: SkillMarketControl.SessionState } = { value: initial }
  const logoutCalls = { value: 0 }
  const navigations: string[] = []
  const source = createSkillMarketControlDataSource("http://127.0.0.1:4210", {
    csrfToken: () => state.value?.csrfToken,
    fetcher: (_input, init) => {
      if (init?.method === "DELETE") {
        logoutCalls.value += 1
        state.value = null
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(Response.json(state.value))
    },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const history = createMemoryHistory()
  history.set({ value: path, replace: true })
  const view = render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => (
            <SkillMarketSessionProvider source={source} navigate={(url) => navigations.push(url)}>
              {content()}
            </SkillMarketSessionProvider>
          )}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ))
  return { view, state, logoutCalls, navigations }
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
