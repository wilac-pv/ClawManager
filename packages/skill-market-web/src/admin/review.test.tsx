import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { MarketControlError } from "../control-data-source"
import type { ModerationReviewSource } from "./review"
import { ModerationReview } from "./review"

afterEach(() => cleanup())

describe("moderation review", () => {
  test("disables self-review with a server-identity explanation", async () => {
    const view = renderReview(source(detail()), "E000001")

    expect(await view.findByText("不能审核自己的投稿")).toBeTruthy()
    expect(view.getByRole("button", { name: "提交审核决定" }).hasAttribute("disabled")).toBe(true)
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
    }
    const view = renderReview(reviewSource)
    await view.findByRole("heading", { name: "审核 Safe Skill" })
    fireEvent.click(view.getByLabelText("拒绝"))
    fireEvent.input(view.getByLabelText("审核意见"), { target: { value: "Unsafe behavior" } })
    fireEvent.click(view.getByRole("button", { name: "提交审核决定" }))

    expect((await view.findByRole("alert")).textContent).toContain("投稿已更新，已刷新到最新版本")
    await waitFor(() => expect(details.value).toBe(2))
  })
})

function renderReview(source: ModerationReviewSource, actor = "E000009") {
  const history = createMemoryHistory()
  history.set({ value: "/admin/submissions/sub_abcdefgh", replace: true })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => <ModerationReview submissionID="sub_abcdefgh" source={source} actor={actor} />}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ))
}

function source(
  value: SkillMarketControl.SubmissionDetail,
  decide: ModerationReviewSource["decide"] = () => Promise.resolve(value),
): ModerationReviewSource {
  return { detail: () => Promise.resolve(value), decide }
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
