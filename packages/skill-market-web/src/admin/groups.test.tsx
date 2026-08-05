import { afterEach, expect, test } from "bun:test"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { MemoryRouter, Route } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { GroupAdministration } from "./groups"

afterEach(() => cleanup())

test("filters all groups returned for an administrator", async () => {
  const view = render(() => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Route path="*" component={() => <GroupAdministration source={{ list: () => Promise.resolve({ managed: [group("Aurora"), group("Atlas")], joined: [] }) }} />} />
      </MemoryRouter>
    </QueryClientProvider>
  ))
  await view.findByText("Aurora")
  fireEvent.input(view.getByLabelText("查找小组"), { target: { value: "atlas" } })
  expect(view.queryByText("Aurora")).toBeNull()
  expect(view.getByText("Atlas")).toBeTruthy()
})

function group(name: string) {
  return { id: `grp_${name.toLowerCase()}123`, name, ownerEmployeeID: "E000001", status: "active" as const, version: 1, createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:00.000Z" }
}
