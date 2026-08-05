import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render } from "@solidjs/testing-library"
import { MemoryRouter, Route } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { GroupList } from "./list"

afterEach(() => cleanup())

describe("group list", () => {
  test("separates managed and joined groups", async () => {
    const view = render(() => (
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Route
            path="*"
            component={() => (
              <GroupList
                source={{
                  list: () => Promise.resolve({ managed: [group("grp_managed01", "Managed")], joined: [group("grp_joined001", "Joined")] }),
                  create: () => Promise.resolve(group("grp_created01", "Created")),
                }}
              />
            )}
          />
        </MemoryRouter>
      </QueryClientProvider>
    ))

    expect(await view.findByRole("heading", { name: "我管理的小组" })).toBeTruthy()
    expect(view.getByRole("heading", { name: "我的小组", level: 1 }).classList).toContain("type-page-title")
    expect(view.queryByText("Sharing groups")).toBeNull()
    expect(view.getByRole("heading", { name: "我加入的小组" })).toBeTruthy()
    expect(view.getByRole("link", { name: /Managed/ })).toBeTruthy()
    expect(view.getByRole("link", { name: /Joined/ })).toBeTruthy()
  })
})

function group(id: string, name: string) {
  return {
    id,
    name,
    ownerEmployeeID: "E000001",
    status: "active" as const,
    version: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  }
}
