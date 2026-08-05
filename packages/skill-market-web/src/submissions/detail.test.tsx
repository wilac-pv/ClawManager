import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { SubmissionDetailSource } from "./detail"
import { SubmissionDetail } from "./detail"
import { submissionPollInterval } from "./status"

afterEach(() => cleanup())

describe("submission detail", () => {
  test("renders an explicit message and allowed action for all eight stable statuses", async () => {
    const cases: Array<{
      status: SkillMarketControl.SubmissionStatus
      message: string
      action?: string
    }> = [
      { status: "validating", message: "正在校验 ZIP 结构和安全规则" },
      { status: "validation_failed", message: "校验未通过", action: "提交修订" },
      { status: "pending_review", message: "已进入人工审核队列" },
      { status: "changes_requested", message: "审核人要求修改", action: "提交修订" },
      { status: "rejected", message: "本次投稿已被拒绝", action: "重新投稿" },
      { status: "publishing", message: "审核已通过，正在发布" },
      { status: "publish_failed", message: "自动发布失败" },
      { status: "published", message: "已发布到用户投稿市场", action: "提交新版本" },
    ]

    for (const item of cases) {
      const fixture = renderDetail(detail(item.status))
      expect(await fixture.findByText(item.message)).toBeTruthy()
      if (item.action) expect(fixture.getByRole("link", { name: item.action })).toBeTruthy()
      if (item.status === "publish_failed") expect(fixture.queryByRole("button", { name: "重试发布" })).toBeNull()
      cleanup()
    }
  })

  test("shows structured validation, redacted scan evidence, review history, and server event order", async () => {
    const fixture = renderDetail(detail("changes_requested"))

    expect(await fixture.findByRole("heading", { name: "Safe Skill" })).toBeTruthy()
    expect(fixture.getByRole("heading", { name: "Safe Skill", level: 1 }).classList).toContain("type-page-title")
    expect([...fixture.container.querySelectorAll(".submission-detail__facts dt")].every((item) => item.classList.contains("type-label"))).toBe(true)
    expect([...fixture.container.querySelectorAll(".submission-detail__facts dd")].every((item) => item.classList.contains("type-body"))).toBe(true)
    expect(fixture.getByText("missing-skill-md")).toBeTruthy()
    expect(fixture.getByText("必须包含 SKILL.md")).toBeTruthy()
    expect(fixture.getByText("secret-pattern")).toBeTruthy()
    expect(fixture.getByText("检测到已脱敏的疑似凭据")).toBeTruthy()
    expect(fixture.getAllByText("请补充使用示例")).toHaveLength(2)
    const events = fixture.getAllByRole("listitem").filter((item) => item.hasAttribute("data-status-event"))
    expect(events.map((item) => item.textContent)).toEqual([
      expect.stringContaining("校验中"),
      expect.stringContaining("待审核"),
      expect.stringContaining("需修改"),
    ])
  })

  test("links a published item to its public community page", async () => {
    const fixture = renderDetail(detail("published"))

    expect((await fixture.findByRole("link", { name: "查看公开 Skill" })).getAttribute("href")).toBe(
      "/skills/community/safe-skill",
    )
    expect(fixture.getByRole("link", { name: "提交新版本" }).getAttribute("href")).toBe(
      "/submissions/new?from=sub_abcdefgh",
    )
  })

  test("offers the authenticated API download for a scanned personal Skill", async () => {
    const fixture = renderDetail({ ...detail("published"), target: "personal" })

    expect(await fixture.findByText("安全扫描已通过，个人 Skill 可以使用")).toBeTruthy()
    expect(fixture.getByText("可用")).toBeTruthy()
    expect(fixture.queryByRole("link", { name: "查看公开 Skill" })).toBeNull()
    expect(fixture.getByRole("link", { name: "下载个人 Skill" }).getAttribute("href")).toBe(
      "http://127.0.0.1:4210/v1/submissions/sub_abcdefgh/package",
    )
  })

  test("promotes a published personal Skill with a fresh reviewed audience", async () => {
    const calls: unknown[][] = []
    const value = { ...detail("published"), target: "personal" as const }
    const fixture = renderDetail(value, {
      promote: (...input) => {
        calls.push(input)
        return Promise.resolve({ submission: { ...value, target: "department", audience: { scope: "department", department: { id: "dep_platform", name: "Platform" } } } })
      },
    })
    fireEvent.click(await fixture.findByRole("button", { name: "发布给其他人" }))
    fireEvent.click(fixture.getByRole("radio", { name: /本部门/ }))
    fireEvent.click(fixture.getByRole("button", { name: "提交审核" }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.[1]).toEqual({ expectedVersion: 3, target: "department", audience: { scope: "department" } })
    expect(calls[0]?.[2]).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("offers joined groups when sharing a personal Skill", async () => {
    const calls: unknown[][] = []
    const value = { ...detail("published"), target: "personal" as const }
    const fixture = renderDetail(
      value,
      {
        promote: (...input) => {
          calls.push(input)
          return Promise.resolve({ submission: value })
        },
      },
      {
        list: () =>
          Promise.resolve({
            managed: [],
            joined: [group("grp_joined01", "Joined group")],
          }),
      },
    )

    fireEvent.click(await fixture.findByRole("button", { name: "发布给其他人" }))
    fireEvent.click(fixture.getByRole("radio", { name: /指定小组/ }))
    fireEvent.click(await fixture.findByRole("checkbox", { name: "Joined group" }))
    fireEvent.click(fixture.getByRole("button", { name: "提交审核" }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.[1]).toEqual({
      expectedVersion: 3,
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_joined01"] },
    })
  })

  test("polls only working states and stops after the bounded request count", () => {
    expect(submissionPollInterval("validating", 1)).toBe(2_000)
    expect(submissionPollInterval("publishing", 19)).toBe(2_000)
    expect(submissionPollInterval("publishing", 20)).toBe(false)
    expect(submissionPollInterval("pending_review", 1)).toBe(false)
    expect(submissionPollInterval(undefined, 0)).toBe(false)
  })

  test("withdraws an in-flight submission with its current version", async () => {
    const calls: unknown[][] = []
    const fixture = renderDetail(detail("validation_failed"), {
      withdraw: (...input) => {
        calls.push(input)
        return Promise.resolve({ ...detail("validation_failed"), status: "withdrawn" })
      },
    })

    fireEvent.click(await fixture.findByRole("button", { name: "撤回投稿" }))
    expect(fixture.getByRole("dialog").textContent).toContain("Safe Skill 1.2.0")
    fireEvent.click(fixture.getByRole("button", { name: "确认撤回" }))
    await waitFor(() => expect(calls[0]?.slice(0, 2)).toEqual(["sub_abcdefgh", { expectedVersion: 3 }]))
    await waitFor(() => expect(fixture.queryByRole("button", { name: "撤回投稿" })).toBeNull())
  })

  test("requests delisting for a published public submission", async () => {
    const calls: unknown[][] = []
    const fixture = renderDetail(detail("published"), {
      requestDelist: (...input) => {
        calls.push(input)
        return Promise.resolve({
          id: "dlr_abcdefgh",
          submissionID: "sub_abcdefgh",
          requestedByEmployeeID: "E000001",
          reason: "No longer maintained",
          version: 1,
          status: "pending",
          createdAt: "2026-08-05T00:00:00.000Z",
        })
      },
    })

    fireEvent.click(await fixture.findByRole("button", { name: "申请下架" }))
    fireEvent.input(fixture.getByLabelText("下架原因"), { target: { value: "No longer maintained" } })
    fireEvent.click(fixture.getByRole("button", { name: "确认申请下架" }))
    await waitFor(() => expect(calls[0]?.slice(0, 2)).toEqual(["sub_abcdefgh", { expectedVersion: 3, reason: "No longer maintained" }]))
    expect(fixture.getByText("下架申请待处理")).toBeTruthy()
  })
})

function renderDetail(
  value: SkillMarketControl.SubmissionDetail,
  overrides: Partial<SubmissionDetailSource> = {},
  groups?: Parameters<typeof SubmissionDetail>[0]["groups"],
) {
  const source: SubmissionDetailSource = {
    detail: () => Promise.resolve(value),
    create: () => Promise.resolve({ submission: value }),
    packageUrl: (submissionID) => `http://127.0.0.1:4210/v1/submissions/${submissionID}/package`,
    revise: () => Promise.resolve({ submission: value }),
    promote: () => Promise.resolve({ submission: value }),
    withdraw: () => Promise.resolve(value),
    requestDelist: () => Promise.reject(new Error("not configured")),
    ...overrides,
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const history = createMemoryHistory()
  history.set({ value: `/submissions/${value.id}`, replace: true })
  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route path="*" component={() => <SubmissionDetail submissionID={value.id} source={source} groups={groups} department={{ id: "dep_platform", name: "Platform" }} />} />
      </MemoryRouter>
    </QueryClientProvider>
  ))
}

function group(id: SkillMarketControl.GroupID, name: string): SkillMarketControl.MarketGroup {
  return {
    id,
    name,
    ownerEmployeeID: "E000002",
    status: "active",
    version: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  }
}

function detail(status: SkillMarketControl.SubmissionStatus): SkillMarketControl.SubmissionDetail {
  const metadata = {
    version: "1.2.0",
    displayName: "Safe Skill",
    description: "A safe submitted Skill",
    category: "Developer Tools",
    tags: ["review"],
    license: "MIT",
    requiresApiKey: false,
    changeNotes: "Add examples",
  }
  return {
    id: "sub_abcdefgh",
    skillID: "safe-skill",
    owner: { employeeID: "E000001", displayName: "Contributor" },
    targetVersion: "1.2.0",
    status,
    currentRevision: 1,
    version: 3,
    risk: "warning",
    ...(status === "published" ? { currentPublicVersion: "1.2.0" } : {}),
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T03:00:00.000Z",
    metadata,
    revisions: [
      {
        number: 1,
        metadata,
        manifest: {
          packageSha256: "a".repeat(64),
          packageSize: 1024,
          files: [{ path: "SKILL.md", sha256: "b".repeat(64), size: 512, mime: "text/markdown" }],
        },
        scan: {
          risk: "warning",
          reasons: ["Requires review"],
          evidence: [
            {
              rule: "secret-pattern",
              summary: "检测到已脱敏的疑似凭据",
              path: "scripts/run.ts",
              line: 8,
            },
          ],
          scannedAt: "2026-07-16T01:00:00.000Z",
        },
        validationIssues: [{ code: "missing-skill-md", message: "必须包含 SKILL.md", path: "SKILL.md" }],
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    ],
    reviews: [
      {
        revision: 1,
        reviewer: { employeeID: "E000002", displayName: "Reviewer" },
        decision: "request_changes",
        comment: "请补充使用示例",
        createdAt: "2026-07-16T03:00:00.000Z",
      },
    ],
    timeline: [
      { status: "validating", at: "2026-07-16T00:00:00.000Z" },
      { status: "pending_review", at: "2026-07-16T02:00:00.000Z" },
      { status: "changes_requested", at: "2026-07-16T03:00:00.000Z", message: "请补充使用示例" },
    ],
    ...(status === "published"
      ? {
          publicSkill: {
            source: "community",
            id: "safe-skill",
            version: "1.2.0",
            rowVersion: 1,
            status: "published",
          },
        }
      : {}),
  }
}
