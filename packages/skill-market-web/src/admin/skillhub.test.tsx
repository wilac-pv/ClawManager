import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { SkillHubImportSource } from "./skillhub"
import { skillHubEvaluationRefetchInterval, SkillHubImport } from "./skillhub"

afterEach(() => cleanup())

describe("SkillHub import administration", () => {
  test("polls TRACE progress only while pending, running, or retry work exists", () => {
    expect(skillHubEvaluationRefetchInterval(evaluationProgress({ pending: 1 }))).toBe(5_000)
    expect(skillHubEvaluationRefetchInterval(evaluationProgress({ running: 1 }))).toBe(5_000)
    expect(skillHubEvaluationRefetchInterval(evaluationProgress({ retryWait: 1 }))).toBe(5_000)
    expect(skillHubEvaluationRefetchInterval(evaluationProgress({ waiting: 1 }))).toBe(false)
    expect(skillHubEvaluationRefetchInterval(evaluationProgress({ completed: 1 }))).toBe(false)
    expect(skillHubEvaluationRefetchInterval(undefined)).toBe(false)
  })

  test("shows independent TRACE evaluation progress without rendering its error in the import banner", async () => {
    const view = renderSkillHub({
      status: () => Promise.resolve(progress()),
      command: () => Promise.resolve(progress()),
      evaluation: () =>
        Promise.resolve({
          total: 100,
          waiting: 0,
          pending: 50,
          running: 2,
          retryWait: 3,
          completed: 40,
          failed: 5,
          ratePerMinute: 60,
          estimatedSecondsRemaining: 55,
          recentError: "SkillHub evaluation timed out",
        }),
    })

    expect(await view.findByRole("heading", { name: "TRACE 评分补齐" })).toBeTruthy()
    expect((view.getByRole("progressbar", { name: "TRACE 评分进度" }).getAttribute("aria-valuenow"))).toBe("45")
    expect(view.getByText("40")).toBeTruthy()
    expect(view.getByText("50")).toBeTruthy()
    expect(view.getByText("5")).toBeTruthy()
    expect(view.getByText("60 个/分钟")).toBeTruthy()
    expect(view.getByText("少于 1 分钟")).toBeTruthy()
    expect(view.getByRole("alert").textContent).toContain("TRACE 评分最近失败")
    expect(view.queryByText(/最近错误：/)).toBeNull()
  })

  test("shows import progress and pauses a running import", async () => {
    const commands: SkillMarketControl.SkillHubImportCommandInput[] = []
    const view = renderSkillHub({
      status: () => Promise.resolve(progress()),
      command: (input) => {
        commands.push(input)
        return Promise.resolve({ ...progress(), state: "paused" })
      },
    })

    expect((await view.findByRole("progressbar", { name: "导入进度" })).getAttribute("aria-valuenow")).toBe("25.6")
    expect(view.getByText("20,000")).toBeTruthy()
    expect(view.getByText("2 MB")).toBeTruthy()
    expect(view.getByText("1,280 个/分钟")).toBeTruthy()
    expect(view.getByText("45 分钟")).toBeTruthy()
    fireEvent.click(view.getByRole("button", { name: "暂停同步" }))

    await waitFor(() => expect(commands).toEqual([{ command: "pause" }]))
    expect(await view.findByRole("button", { name: "恢复同步" })).toBeTruthy()
  })

  test("renders independent retry controls and confirms rejected targets", async () => {
    const commands: SkillMarketControl.SkillHubImportCommandInput[] = []
    const view = renderSkillHub({
      status: () => Promise.resolve(progress({ state: "paused", retryWait: 4, rejected: 2 })),
      command: (input) => {
        commands.push(input)
        return Promise.resolve(
          progress(
            input.command === "retry-rejected"
              ? { state: "running", retryWait: 0, rejected: 0 }
              : { state: "paused", retryWait: 0, rejected: 2 },
          ),
        )
      },
    })

    expect(await view.findByRole("button", { name: "重试等待项（4）" })).toBeTruthy()
    fireEvent.click(view.getByRole("button", { name: "重试等待项（4）" }))
    await waitFor(() => expect(commands).toEqual([{ command: "retry-wait" }]))

    fireEvent.input(view.getByLabelText("已拒绝 Skill 的 slug"), { target: { value: "unsafe-skill, legacy-skill" } })
    fireEvent.click(view.getByRole("button", { name: "重试已拒绝项（2）" }))
    expect(await view.findByRole("region", { name: "重试已拒绝项确认" })).toBeTruthy()
    fireEvent.click(view.getByRole("button", { name: "确认重试已拒绝项" }))

    await waitFor(() =>
      expect(commands).toEqual([
        { command: "retry-wait" },
        { command: "retry-rejected", slugs: ["unsafe-skill", "legacy-skill"] },
      ]),
    )
  })

  test("disables every import control while a command is pending", async () => {
    const commands: SkillMarketControl.SkillHubImportCommandInput[] = []
    let resolve: ((value: SkillMarketControl.SkillHubImportProgress) => void) | undefined
    const view = renderSkillHub({
      status: () => Promise.resolve(progress({ state: "paused", retryWait: 4, rejected: 2 })),
      command: (input) => {
        commands.push(input)
        return new Promise((done) => {
          resolve = done
        })
      },
    })

    fireEvent.click(await view.findByRole("button", { name: "恢复同步" }))
    await waitFor(() => expect(commands).toEqual([{ command: "resume" }]))
    expect(view.getByRole("button", { name: "恢复同步" }).hasAttribute("disabled")).toBe(true)
    expect(view.getByRole("button", { name: "重试等待项（4）" }).hasAttribute("disabled")).toBe(true)
    expect(view.getByLabelText("已拒绝 Skill 的 slug").hasAttribute("disabled")).toBe(true)
    fireEvent.click(view.getByRole("button", { name: "恢复同步" }))
    expect(commands).toEqual([{ command: "resume" }])
    resolve?.(progress({ state: "running" }))
  })

  test("renders zero-total progress and labels unknown estimates accessibly", async () => {
    const view = renderSkillHub({
      status: () => Promise.resolve(progress({ upstreamTotal: 0, mirrored: 5, rejected: 2, estimatedSecondsRemaining: undefined })),
      command: () => Promise.resolve(progress()),
    })

    expect((await view.findByRole("progressbar", { name: "导入进度" })).getAttribute("aria-valuenow")).toBe("0")
    expect(view.getByLabelText("预计剩余时间").textContent).toContain("未知")
  })

  test("caps processed items above the upstream total at 100 percent", async () => {
    const view = renderSkillHub({
      status: () => Promise.resolve(progress({ upstreamTotal: 3, mirrored: 5, rejected: 2 })),
      command: () => Promise.resolve(progress()),
    })

    expect((await view.findByRole("progressbar", { name: "导入进度" })).getAttribute("aria-valuenow")).toBe("100")
  })

  test("redacts untrusted recent-error summaries while showing a local error label", async () => {
    const view = renderSkillHub({
      status: () =>
        Promise.resolve(
          progress({
            recentError: {
              code: "storage",
              summary: "Authorization: Bearer top-secret-token https://internal.example.com/imports/42",
              occurredAt: "2026-07-17T10:01:00.000Z",
            },
          }),
        ),
      command: () => Promise.resolve(progress()),
    })

    const error = await view.findByRole("alert")
    expect(error.textContent).toContain("存储失败")
    expect(error.textContent).toContain("详情请查看服务端日志")
    expect(view.container.innerHTML).not.toContain("top-secret-token")
    expect(view.container.innerHTML).not.toContain("internal.example.com")
  })
})

function renderSkillHub(
  source: Omit<SkillHubImportSource, "evaluation"> & Partial<Pick<SkillHubImportSource, "evaluation">>,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <SkillHubImport source={{ ...source, evaluation: source.evaluation ?? (() => Promise.resolve(evaluationProgress())) }} />
    </QueryClientProvider>
  ))
}

function evaluationProgress(
  changes: Partial<SkillMarketControl.SkillHubEvaluationProgress> = {},
): SkillMarketControl.SkillHubEvaluationProgress {
  return {
    total: 0,
    waiting: 0,
    pending: 0,
    running: 0,
    retryWait: 0,
    completed: 0,
    failed: 0,
    ratePerMinute: 0,
    ...changes,
  }
}

function progress(
  changes: Partial<SkillMarketControl.SkillHubImportProgress> = {},
): SkillMarketControl.SkillHubImportProgress {
  return {
    state: "running",
    sourceStatus: "fresh",
    upstreamTotal: 78_253,
    discovered: 35_100,
    pending: 3_000,
    running: 8,
    mirrored: 20_000,
    retryWait: 0,
    rejected: 0,
    uploadedBytes: 2 * 1024 * 1024,
    ratePerMinute: 1_280,
    estimatedSecondsRemaining: 45 * 60,
    discoveryPage: 112,
    sweep: 3,
    metadataConcurrency: 8,
    packageConcurrency: 4,
    updatedAt: "2026-07-17T10:00:00.000Z",
    ...changes,
  }
}
