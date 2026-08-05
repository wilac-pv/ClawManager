import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { AuditLogSource } from "./audit"
import { AuditLog } from "./audit"

afterEach(() => cleanup())

describe("audit log", () => {
  test("filters immutable events and redacts sensitive summary fields", async () => {
    const calls: SkillMarketControl.AuditQuery[] = []
    const source: AuditLogSource = {
      list: (query) => {
        calls.push(query)
        return Promise.resolve({ total: 1, page: query.page, limit: 30, items: [event] })
      },
    }
    const view = renderAudit(source, "/admin/audit?actor=E000009&action=role-assigned&objectType=role&page=2")

    expect(await view.findByText("req_abcdef")).toBeTruthy()
    expect(view.getByRole("heading", { name: "审计日志", level: 1 }).classList).toContain("type-page-title")
    expect(view.getByText("req_abcdef").classList).toContain("machine-id")
    expect(view.container.textContent).not.toContain("Admin workspace")
    expect(calls[0]).toMatchObject({ actor: "E000009", action: "role-assigned", objectType: "role", page: 2 })
    expect(view.container.textContent).toContain("[REDACTED]")
    expect(view.container.textContent).not.toContain("sensitive-token-value")
    expect(view.queryByRole("button", { name: /删除|编辑|导出/ })).toBeNull()

    fireEvent.change(view.getByLabelText("操作类型"), { target: { value: "role-removed" } })
    expect(await view.findByText("第 1 / 1 页")).toBeTruthy()
    expect(calls.at(-1)).toMatchObject({ action: "role-removed", page: 1 })
  })
})

const event = {
  id: "aud_abcdefgh",
  actor: { employeeID: "E000009", displayName: "Admin User" },
  action: "role-assigned",
  objectType: "role",
  objectID: "E000002:reviewer",
  before: { accessToken: "sensitive-token-value" },
  after: { role: "reviewer", nested: { password: "sensitive-token-value" } },
  requestID: "req_abcdef",
  createdAt: "2026-07-16T00:00:00.000Z",
} satisfies SkillMarketControl.AuditEvent

function renderAudit(source: AuditLogSource, path: string) {
  const history = createMemoryHistory()
  history.set({ value: path, replace: true })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route path="*" component={() => <AuditLog source={source} />} />
      </MemoryRouter>
    </QueryClientProvider>
  ))
}
