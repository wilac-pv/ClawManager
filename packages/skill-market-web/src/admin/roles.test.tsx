import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { MarketControlError } from "../control-data-source"
import type { RoleAdministrationSource } from "./roles"
import { RoleAdministration } from "./roles"

afterEach(() => cleanup())

describe("role administration", () => {
  test("explains an empty employee ID without calling the server", async () => {
    const calls: SkillMarketControl.RoleInput[] = []
    const view = renderRoles({
      list: () => Promise.resolve([]),
      assign: (input) => {
        calls.push(input)
        return Promise.resolve(assignment(input.employeeID, input.role))
      },
      remove: () => Promise.resolve([]),
    })
    const button = view.getByRole("button", { name: "添加角色" })
    expect(button.hasAttribute("disabled")).toBe(false)
    fireEvent.click(button)
    expect((await view.findByRole("alert")).textContent).toContain("请输入员工工号。")
    expect(calls).toEqual([])
  })

  test("adds server-resolved Reviewer/Admin assignments and shows disabled users", async () => {
    const assignments = [assignment("E000001", "admin", { disabledAt: "2026-07-16T00:00:00.000Z" })]
    const calls: SkillMarketControl.RoleInput[] = []
    const source: RoleAdministrationSource = {
      list: () => Promise.resolve(assignments),
      assign: (input) => {
        calls.push(input)
        const result = assignment(input.employeeID, input.role)
        return Promise.resolve(result)
      },
      remove: () => Promise.resolve(assignments),
    }
    const view = renderRoles(source)
    expect(await view.findByText("账号已禁用")).toBeTruthy()
    expect(view.getByRole("heading", { name: "角色管理", level: 1 }).classList).toContain("type-page-title")
    expect(view.container.textContent).not.toContain("Admin workspace")
    expect(view.getByText("E000001").classList).toContain("machine-id")
    fireEvent.input(view.getByLabelText("员工工号"), { target: { value: "E000002" } })
    fireEvent.change(view.getByLabelText("角色"), { target: { value: "reviewer" } })
    fireEvent.click(view.getByRole("button", { name: "添加角色" }))

    await waitFor(() => expect(calls).toEqual([{ employeeID: "E000002", role: "reviewer" }]))
    expect(await view.findByText("User E000002")).toBeTruthy()
  })

  test("keeps duplicate assignment and last-admin errors next to the attempted action", async () => {
    const source: RoleAdministrationSource = {
      list: () => Promise.resolve([assignment("E000001", "admin")]),
      assign: () =>
        Promise.reject(new MarketControlError(400, "invalid-request", "role is already assigned", "req_dup001")),
      remove: () =>
        Promise.reject(new MarketControlError(409, "last-admin", "the last admin cannot be removed", "req_last01")),
    }
    const view = renderRoles(source)
    await view.findByText("User E000001")
    fireEvent.input(view.getByLabelText("员工工号"), { target: { value: "E000001" } })
    fireEvent.click(view.getByRole("button", { name: "添加角色" }))
    expect((await view.findByRole("alert")).textContent).toContain("role is already assigned")

    fireEvent.click(view.getByRole("button", { name: "移除 E000001 的 Admin" }))
    fireEvent.click(view.getByRole("button", { name: "确认移除" }))
    expect((await view.findByRole("alert")).textContent).toContain("the last admin cannot be removed")
  })
})

function renderRoles(source: RoleAdministrationSource) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <RoleAdministration source={source} />
    </QueryClientProvider>
  ))
}

function assignment(
  employeeID: string,
  role: SkillMarketControl.Role,
  user: Partial<SkillMarketControl.User> = {},
): SkillMarketControl.RoleAssignment {
  return {
    user: { employeeID, displayName: `User ${employeeID}`, ...user },
    role,
    createdBy: "E000009",
    createdAt: "2026-07-16T00:00:00.000Z",
  }
}
