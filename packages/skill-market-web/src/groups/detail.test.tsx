import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { GroupDetail } from "./detail"

afterEach(() => cleanup())

describe("group detail", () => {
  test("lets members view but never renders mutation controls", async () => {
    const source = {
      detail: () => Promise.resolve(group),
      members: () => Promise.resolve([member]),
      update: () => Promise.resolve(group),
      transfer: () => Promise.resolve(group),
      setStatus: () => Promise.resolve(group),
      addMember: () => Promise.resolve(member),
      removeMember: () => Promise.resolve(group),
    }
    const view = render(() => (
      <QueryClientProvider client={new QueryClient()}>
        <GroupDetail groupID={group.id} source={source} actor="E000002" admin={false} />
      </QueryClientProvider>
    ))

    expect(await view.findByRole("heading", { name: "Project Aurora" })).toBeTruthy()
    expect(view.getByText("E000002")).toBeTruthy()
    expect(view.queryByRole("button", { name: "添加成员" })).toBeNull()
    expect(view.queryByRole("button", { name: "停用小组" })).toBeNull()
  })
})

const group = {
  id: "grp_aurora123",
  name: "Project Aurora",
  ownerEmployeeID: "E000001",
  status: "active" as const,
  version: 1,
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
}
const member = { groupID: group.id, employeeID: "E000002", createdByEmployeeID: "E000001", createdAt: group.createdAt }
