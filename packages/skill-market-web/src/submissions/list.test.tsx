import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { SubmissionList } from "./list"

afterEach(() => cleanup())

describe("submission list", () => {
  test("shows an empty state and the primary submission action", async () => {
    const fixture = renderList(() => Promise.resolve(page([])))

    expect(await fixture.view.findByRole("heading", { name: "还没有投稿" })).toBeTruthy()
    expect(fixture.view.getByRole("link", { name: "投稿 Skill" }).getAttribute("href")).toBe("/submissions/new")
  })

  test("renders every stable status distinctly without exposing another owner's identity", async () => {
    const statuses: SkillMarketControl.SubmissionStatus[] = [
      "validating",
      "validation_failed",
      "pending_review",
      "changes_requested",
      "rejected",
      "publishing",
      "publish_failed",
      "published",
    ]
    const items = statuses.map((status, index) => submission(status, index))
    items[7] = submission("published", 7, { employeeID: "E999999", displayName: "Another User" })
    const fixture = renderList(() => Promise.resolve(page(items)))

    expect(await fixture.view.findByText("共 8 个投稿")).toBeTruthy()
    ;["校验失败", "待审核", "需修改", "已拒绝", "发布中", "发布失败", "已发布"].forEach((label) =>
      expect(fixture.view.getAllByText(label).length).toBeGreaterThan(1),
    )
    expect(fixture.view.getAllByText("校验中").length).toBeGreaterThan(1)
    expect(fixture.view.queryByText("Another User")).toBeNull()
    expect(fixture.view.getByRole("link", { name: "提交新版本" }).getAttribute("href")).toBe(
      "/submissions/new?from=sub_abcdefgh7",
    )
  })

  test("keeps status and pagination in the URL-backed query", async () => {
    const calls: SkillMarketControl.SubmissionListQuery[] = []
    const fixture = renderList((query) => {
      calls.push(query)
      return Promise.resolve({ ...page([submission("changes_requested", 1)]), total: 61, page: query.page })
    }, "/submissions?status=changes_requested&page=2")

    expect(await fixture.view.findByText("第 2 / 3 页")).toBeTruthy()
    expect(calls[0]).toEqual({ status: "changes_requested", page: 2, limit: 30 })
    expect(fixture.view.getByRole("link", { name: "上一页" }).getAttribute("href")).toBe(
      "/submissions?status=changes_requested&page=1",
    )
    expect(fixture.view.getByRole("link", { name: "下一页" }).getAttribute("href")).toBe(
      "/submissions?status=changes_requested&page=3",
    )

    fireEvent.change(fixture.view.getByLabelText("投稿状态"), { target: { value: "published" } })
    expect(await fixture.view.findByText("第 1 / 3 页")).toBeTruthy()
    expect(calls.at(-1)).toEqual({ status: "published", page: 1, limit: 30 })
  })
})

function renderList(
  list: (query: SkillMarketControl.SubmissionListQuery) => Promise<SkillMarketControl.SubmissionPage>,
  path = "/submissions",
) {
  const source = { list: (query: SkillMarketControl.SubmissionListQuery) => list(query) }
  const history = createMemoryHistory()
  history.set({ value: path, replace: true })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const view = render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route path="*" component={() => <SubmissionList source={source} />} />
      </MemoryRouter>
    </QueryClientProvider>
  ))
  return { view }
}

function page(items: SkillMarketControl.SubmissionSummary[]): SkillMarketControl.SubmissionPage {
  return { total: items.length, page: 1, limit: 30, items }
}

function submission(
  status: SkillMarketControl.SubmissionStatus,
  index: number,
  owner = { employeeID: "E000001", displayName: "Contributor" },
): SkillMarketControl.SubmissionSummary {
  return {
    id: `sub_abcdefgh${index}`,
    skillID: `safe-skill-${index}`,
    owner,
    targetVersion: `1.${index}.0`,
    status,
    currentRevision: 1,
    version: 1,
    risk: "unknown",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T01:00:00.000Z",
  }
}
