import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { ModerationQueueSource } from "./queue"
import { ModerationQueue } from "./queue"

afterEach(() => cleanup())

describe("moderation queue", () => {
  test("shows stable risk/status labels and oldest-first wait information", async () => {
    const source: ModerationQueueSource = {
      list: () => Promise.resolve(page([summary("pending_review", "warning"), summary("publish_failed", "danger", 1)])),
    }
    const view = renderQueue(source)

    expect(await view.findByText("共 2 个投稿")).toBeTruthy()
    expect(view.getAllByText("待审核").length).toBeGreaterThan(1)
    expect(view.getAllByText("警告").length).toBeGreaterThan(1)
    expect(view.getAllByText("危险").length).toBeGreaterThan(1)
    expect(view.getByText("已等待 3 小时")).toBeTruthy()
    expect(view.getByRole("link", { name: "审核 safe-skill-0" }).getAttribute("href")).toBe(
      "/admin/submissions/sub_abcdefgh0",
    )
  })

  test("shows each scoped target without exposing package keys", async () => {
    const scoped = {
      ...summary("pending_review", "safe"),
      target: "groups" as const,
      audience: { scope: "groups" as const, groupIDs: ["grp_aurora001"] },
    }
    const view = renderQueue({ list: () => Promise.resolve(page([scoped])) })

    expect(await view.findByText("群组 · grp_aurora001")).toBeTruthy()
    expect(view.queryByText(/private\//i)).toBeNull()
  })

  test("preserves queue filters and pagination in query parameters", async () => {
    const calls: SkillMarketControl.AdminSubmissionQuery[] = []
    const source: ModerationQueueSource = {
      list: (query) => {
        calls.push(query)
        return Promise.resolve({ ...page([summary("pending_review", "warning")]), total: 61, page: query.page })
      },
    }
    const view = renderQueue(
      source,
      "/admin?status=pending_review&risk=warning&submitter=E000001&createdFrom=2026-07-15&createdTo=2026-07-16&page=2",
    )

    expect(await view.findByText("第 2 / 3 页")).toBeTruthy()
    expect(calls[0]).toEqual({
      status: "pending_review",
      risk: "warning",
      submitter: "E000001",
      createdFrom: "2026-07-15T00:00:00.000Z",
      createdTo: "2026-07-16T23:59:59.999Z",
      page: 2,
      limit: 30,
    })
    fireEvent.change(view.getByLabelText("风险等级"), { target: { value: "danger" } })
    expect(await view.findByText("第 1 / 3 页")).toBeTruthy()
    expect(calls.at(-1)).toMatchObject({ risk: "danger", page: 1 })
  })

  test("renders empty and retryable error states", async () => {
    const empty = renderQueue({ list: () => Promise.resolve(page([])) })
    expect(await empty.findByRole("heading", { name: "没有匹配的投稿" })).toBeTruthy()
    cleanup()

    const failed = renderQueue({ list: () => Promise.reject(new Error("offline")) })
    expect((await failed.findByRole("alert")).textContent).toContain("审核队列加载失败")
    expect(failed.getByRole("button", { name: "重新加载" })).toBeTruthy()
  })
})

function renderQueue(source: ModerationQueueSource, path = "/admin") {
  const history = createMemoryHistory()
  history.set({ value: path, replace: true })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => <ModerationQueue source={source} now={() => Date.parse("2026-07-16T03:00:00.000Z")} />}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ))
}

function page(items: SkillMarketControl.SubmissionSummary[]): SkillMarketControl.SubmissionPage {
  return { total: items.length, page: 1, limit: 30, items }
}

function summary(
  status: SkillMarketControl.SubmissionStatus,
  risk: SkillMarketControl.SubmissionSummary["risk"],
  index = 0,
): SkillMarketControl.SubmissionSummary {
  return {
    id: `sub_abcdefgh${index}`,
    skillID: `safe-skill-${index}`,
    owner: { employeeID: `E00000${index + 1}`, displayName: `Contributor ${index + 1}` },
    targetVersion: "1.2.0",
    status,
    currentRevision: 1,
    version: 3,
    risk,
    createdAt: index === 0 ? "2026-07-16T00:00:00.000Z" : "2026-07-16T01:00:00.000Z",
    updatedAt: "2026-07-16T02:00:00.000Z",
  }
}
