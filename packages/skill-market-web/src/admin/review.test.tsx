import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { MarketControlError } from "../control-data-source"
import type { ModerationOperationsSource, ModerationReviewSource } from "./review"
import { ModerationReview } from "./review"

afterEach(() => cleanup())

describe("moderation review", () => {
  test("disables Reviewer self-review with a server-identity explanation", async () => {
    const view = renderReview(source(detail()), "E000001")

    expect(await view.findByText("不能审核自己的投稿")).toBeTruthy()
    expect(view.getByRole("heading", { name: "审核 Safe Skill", level: 1 }).classList).toContain("type-page-title")
    expect([...view.container.querySelectorAll(".moderation-review__overview dt")].every((item) => item.classList.contains("type-label"))).toBe(true)
    expect([...view.container.querySelectorAll(".moderation-review__overview dd")].every((item) => item.classList.contains("type-body"))).toBe(true)
    expect(view.getAllByText("safe-skill").every((item) => item.classList.contains("machine-id"))).toBe(true)
    expect(view.getByText("E000001").classList).toContain("machine-id")
    expect(view.getByRole("button", { name: "提交审核决定" }).hasAttribute("disabled")).toBe(true)
  })

  test("shows the resolved department audience before a Reviewer approves", async () => {
    const fixture = {
      ...detail(),
      target: "department" as const,
      audience: { scope: "department" as const, department: { id: "department-platform", name: "平台研发部" } },
    }
    const view = renderReview(source(fixture))

    expect(await view.findByText("发布范围")).toBeTruthy()
    expect(view.getByText("发布范围").parentElement?.querySelector("dd")?.textContent).toBe("部门 · 平台研发部（department-platform）")
    expect(view.getByText("department-platform").classList).toContain("machine-id")
    expect(view.queryByText(/private\//i)).toBeNull()
  })

  test("allows Admin to review an owned submission", async () => {
    const calls: SkillMarketControl.DecisionInput[] = []
    const fixture = { ...detail(), risk: "safe" as const }
    const view = renderReview(
      source(fixture, (_id, input) => {
        calls.push(input)
        return Promise.resolve({ ...fixture, status: "publishing", version: 4 })
      }),
      "E000001",
      { admin: true },
    )

    await view.findByRole("heading", { name: "审核 Safe Skill" })
    expect(view.queryByText("不能审核自己的投稿")).toBeNull()
    fireEvent.click(view.getByLabelText("通过"))
    fireEvent.input(view.getByLabelText("审核意见"), { target: { value: "Admin reviewed the package" } })
    fireEvent.click(view.getByRole("button", { name: "提交审核决定" }))

    await waitFor(() =>
      expect(calls).toEqual([
        { expectedVersion: 3, decision: "approve", comment: "Admin reviewed the package" },
      ]),
    )
  })

  test("requires a comment and typed risk confirmation before approval", async () => {
    const calls: SkillMarketControl.DecisionInput[] = []
    const fixture = detail()
    const view = renderReview(
      source(fixture, (_id, input) => {
        calls.push(input)
        return Promise.resolve({ ...fixture, status: "publishing", version: 4 })
      }),
    )
    await view.findByRole("heading", { name: "审核 Safe Skill" })
    fireEvent.click(view.getByLabelText("通过"))
    fireEvent.click(view.getByRole("button", { name: "提交审核决定" }))
    expect((await view.findByRole("alert")).textContent).toContain("请填写审核意见")

    fireEvent.input(view.getByLabelText("审核意见"), { target: { value: "Reviewed package and accepted risk" } })
    fireEvent.click(view.getByRole("button", { name: "提交审核决定" }))
    expect((await view.findByRole("alert")).textContent).toContain("请输入 safe-skill 以确认")

    fireEvent.input(view.getByLabelText("输入 Skill ID 以确认"), { target: { value: "safe-skill" } })
    fireEvent.click(view.getByRole("button", { name: "提交审核决定" }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      expectedVersion: 3,
      decision: "approve",
      comment: "Reviewed package and accepted risk",
      acceptedRiskSummary: "警告：Requires review",
    })
  })

  test("prevents double submission while the decision is pending", async () => {
    let resolveDecision: ((value: SkillMarketControl.SubmissionDetail) => void) | undefined
    const calls = { value: 0 }
    const fixture = { ...detail(), risk: "safe" as const }
    const view = renderReview(
      source(fixture, () => {
        calls.value += 1
        return new Promise((resolve) => {
          resolveDecision = resolve
        })
      }),
    )
    await view.findByRole("heading", { name: "审核 Safe Skill" })
    fireEvent.click(view.getByLabelText("要求修改"))
    fireEvent.input(view.getByLabelText("审核意见"), { target: { value: "Please add examples" } })
    const button = view.getByRole("button", { name: "提交审核决定" })
    fireEvent.click(button)
    fireEvent.click(button)

    expect(view.getByRole("button", { name: "正在提交…" }).hasAttribute("disabled")).toBe(true)
    expect(calls.value).toBe(1)
    resolveDecision?.({ ...fixture, status: "changes_requested", version: 4 })
  })

  test("refreshes the loaded version after a concurrent conflict", async () => {
    const details = { value: 0 }
    const fixture = { ...detail(), risk: "safe" as const }
    const reviewSource: ModerationReviewSource = {
      detail: () => {
        details.value += 1
        return Promise.resolve({ ...fixture, version: details.value === 1 ? 3 : 4 })
      },
      decide: () => Promise.reject(new MarketControlError(409, "submission-conflict", "投稿已更新", "req_abcdef")),
      pendingDelist: () => Promise.resolve([]),
    }
    const view = renderReview(reviewSource)
    await view.findByRole("heading", { name: "审核 Safe Skill" })
    fireEvent.click(view.getByLabelText("拒绝"))
    fireEvent.input(view.getByLabelText("审核意见"), { target: { value: "Unsafe behavior" } })
    fireEvent.click(view.getByRole("button", { name: "提交审核决定" }))

    expect((await view.findByRole("alert")).textContent).toContain("投稿已更新，已刷新到最新版本")
    await waitFor(() => expect(details.value).toBe(2))
  })

  test("lets Admin retry publication and delist/restore with returned row versions", async () => {
    const retryCalls: SkillMarketControl.ExpectedVersionInput[] = []
    const statusCalls: Array<{ kind: "delist" | "restore"; input: SkillMarketControl.ReasonInput }> = []
    const operations: ModerationOperationsSource = {
      retryPublish: (_id, input) => {
        retryCalls.push(input)
        return Promise.resolve({ ...detail(), status: "publishing", version: 4 })
      },
      delist: (_id, input) => {
        statusCalls.push({ kind: "delist", input })
        return Promise.resolve({
          source: "community",
          id: "safe-skill",
          version: "1.2.0",
          rowVersion: 2,
          status: "delisted",
        })
      },
      restore: (_id, input) => {
        statusCalls.push({ kind: "restore", input })
        return Promise.resolve({
          source: "community",
          id: "safe-skill",
          version: "1.2.0",
          rowVersion: 3,
          status: "published",
        })
      },
      approveDelist: () => Promise.reject(new Error("not configured")),
      rejectDelist: () => Promise.reject(new Error("not configured")),
    }
    const failed = { ...detail(), status: "publish_failed" as const, risk: "safe" as const }
    const retry = renderReview(source(failed), "E000009", { admin: true, operations })
    await retry.findByRole("heading", { name: "审核 Safe Skill" })
    fireEvent.click(retry.getByRole("button", { name: "重试发布" }))
    await waitFor(() => expect(retryCalls).toEqual([{ expectedVersion: 3 }]))
    cleanup()

    const published = {
      ...detail(),
      status: "published" as const,
      risk: "safe" as const,
      publicSkill: {
        source: "community" as const,
        id: "safe-skill",
        version: "1.2.0",
        rowVersion: 1,
        status: "published" as const,
      },
    }
    const operation = renderReview(source(published), "E000009", { admin: true, operations })
    await operation.findByRole("heading", { name: "审核 Safe Skill" })
    fireEvent.click(operation.getByRole("button", { name: "下架 Skill" }))
    expect(operation.getByText("下架会移除公开可见性，但保留包与全部历史。")).toBeTruthy()
    fireEvent.input(operation.getByLabelText("操作原因"), { target: { value: "Policy review" } })
    fireEvent.click(operation.getByRole("button", { name: "确认下架" }))
    expect(await operation.findByRole("button", { name: "恢复 Skill" })).toBeTruthy()

    fireEvent.click(operation.getByRole("button", { name: "恢复 Skill" }))
    fireEvent.input(operation.getByLabelText("操作原因"), { target: { value: "Policy issue resolved" } })
    fireEvent.click(operation.getByRole("button", { name: "确认恢复" }))
    await waitFor(() =>
      expect(statusCalls).toEqual([
        { kind: "delist", input: { expectedVersion: 1, reason: "Policy review" } },
        { kind: "restore", input: { expectedVersion: 2, reason: "Policy issue resolved" } },
      ]),
    )
  })

  test("only lets Admin decide a pending delist request using its request version", async () => {
    const calls: unknown[][] = []
    const operations = {
      retryPublish: () => Promise.resolve(detail()),
      delist: () => Promise.resolve({ source: "community" as const, id: "safe-skill", version: "1.2.0", rowVersion: 2, status: "delisted" as const }),
      restore: () => Promise.resolve({ source: "community" as const, id: "safe-skill", version: "1.2.0", rowVersion: 2, status: "published" as const }),
      approveDelist: (...input: unknown[]) => {
        calls.push(input)
        return Promise.resolve({ ...delistRequest(), status: "approved" as const, decidedByEmployeeID: "E000009", decidedAt: "2026-08-05T01:00:00.000Z" })
      },
      rejectDelist: () => Promise.resolve({ ...delistRequest(), status: "rejected" as const, decidedByEmployeeID: "E000009", decidedAt: "2026-08-05T01:00:00.000Z" }),
    }
    const reviewer = renderReview(source(detail()), "E000009", { admin: false, operations, delistRequest: delistRequest() })
    await reviewer.findByRole("heading", { name: "审核 Safe Skill" })
    expect(reviewer.queryByRole("button", { name: "批准下架" })).toBeNull()
    cleanup()

    const admin = renderReview(source(detail()), "E000009", { admin: true, operations, delistRequest: delistRequest() })
    await admin.findByRole("heading", { name: "审核 Safe Skill" })
    fireEvent.click(admin.getByRole("button", { name: "批准下架" }))
    expect(admin.getByRole("dialog").textContent).toContain("sub_abcdefgh")
    fireEvent.click(admin.getByRole("button", { name: "确认批准下架" }))
    await waitFor(() => expect(calls[0]?.slice(0, 2)).toEqual(["dlr_abcdefgh", { expectedVersion: 2 }]))
  })
})

function renderReview(
  source: ModerationReviewSource,
  actor = "E000009",
  admin?: { admin: boolean; operations?: ModerationOperationsSource; delistRequest?: SkillMarketControl.DelistRequest },
) {
  const history = createMemoryHistory()
  history.set({ value: "/admin/submissions/sub_abcdefgh", replace: true })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => (
            <ModerationReview
              submissionID="sub_abcdefgh"
              source={source}
              actor={actor}
              admin={admin?.admin}
              operations={admin?.operations}
              delistRequest={admin?.delistRequest}
            />
          )}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ))
}

function delistRequest(): SkillMarketControl.DelistRequest {
  return {
    id: "dlr_abcdefgh",
    submissionID: "sub_abcdefgh",
    requestedByEmployeeID: "E000001",
    reason: "No longer maintained",
    version: 2,
    status: "pending",
    createdAt: "2026-08-05T00:00:00.000Z",
  }
}

function source(
  value: SkillMarketControl.SubmissionDetail,
  decide: ModerationReviewSource["decide"] = () => Promise.resolve(value),
): ModerationReviewSource {
  return { detail: () => Promise.resolve(value), decide, pendingDelist: () => Promise.resolve([]) }
}

function detail(): SkillMarketControl.SubmissionDetail {
  const metadata = {
    version: "1.2.0",
    displayName: "Safe Skill",
    description: "A safe submitted Skill",
    category: "Developer Tools",
    tags: ["review"],
    requiresApiKey: false,
    changeNotes: "Add examples",
  }
  return {
    id: "sub_abcdefgh",
    skillID: "safe-skill",
    owner: { employeeID: "E000001", displayName: "Contributor" },
    targetVersion: "1.2.0",
    status: "pending_review",
    currentRevision: 1,
    version: 3,
    risk: "warning",
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
          evidence: [{ rule: "secret-pattern", summary: "Redacted credential", path: "scripts/run.ts", line: 8 }],
          scannedAt: "2026-07-16T01:00:00.000Z",
        },
        validationIssues: [],
        createdAt: "2026-07-16T00:00:00.000Z",
      },
    ],
    reviews: [],
    timeline: [
      { status: "validating", at: "2026-07-16T00:00:00.000Z" },
      { status: "pending_review", at: "2026-07-16T02:00:00.000Z" },
    ],
  }
}
