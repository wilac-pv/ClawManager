import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MarketControlError } from "../control-data-source"
import type { SubmissionWriter } from "./form"
import { SubmissionForm } from "./form"

afterEach(() => cleanup())

describe("submission form", () => {
  test("exposes accessible fields and focuses a complete validation summary", async () => {
    const fixture = renderForm(writer())

    expect(fixture.view.getByLabelText("Skill ZIP 包").getAttribute("accept")).toBe(".zip,application/zip")
    fireEvent.click(fixture.view.getByRole("button", { name: "提交审核" }))

    const alert = await fixture.view.findByRole("alert")
    expect(alert.textContent).toContain("请选择 ZIP 包")
    expect(alert.textContent).toContain("版本号不能为空")
    expect(alert.textContent).toContain("名称不能为空")
    expect(alert.textContent).toContain("描述不能为空")
    expect(alert.textContent).toContain("分类不能为空")
    expect(alert.textContent).toContain("变更说明不能为空")
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })

  test("prechecks SemVer, the 50 MiB ZIP limit, and the optional 1 MiB image limit", async () => {
    const fixture = renderForm(writer())
    fillMetadata(fixture.view, { version: "01.2.0" })
    const packageFile = sizedFile("unsafe.zip", 50 * 1024 * 1024 + 1, "application/zip")
    const iconFile = sizedFile("icon.png", 1024 * 1024 + 1, "image/png")
    fireEvent.change(fixture.view.getByLabelText("Skill ZIP 包"), { target: { files: [packageFile] } })
    fireEvent.change(fixture.view.getByLabelText("Skill 图标（可选）"), { target: { files: [iconFile] } })
    fireEvent.click(fixture.view.getByRole("button", { name: "提交审核" }))

    const alert = await fixture.view.findByRole("alert")
    expect(alert.textContent).toContain("请输入有效的 SemVer")
    expect(alert.textContent).toContain("ZIP 包不能超过 50 MiB")
    expect(alert.textContent).toContain("图标不能超过 1 MiB")
  })

  test("submits direct files and normalized bounded metadata", async () => {
    const calls: Array<{ input: Parameters<SubmissionWriter["create"]>[0]; key: string }> = []
    const accepted: string[] = []
    const source = writer((input, key) => {
      calls.push({ input, key })
      return Promise.resolve({ submission: summary })
    })
    const fixture = renderForm(source, (id) => accepted.push(id))
    fillMetadata(fixture.view)
    const packageFile = new File(["zip"], "safe-skill.zip", { type: "application/zip" })
    const iconFile = new File(["icon"], "safe-skill.png", { type: "image/png" })
    fireEvent.change(fixture.view.getByLabelText("Skill ZIP 包"), { target: { files: [packageFile] } })
    fireEvent.change(fixture.view.getByLabelText("Skill 图标（可选）"), { target: { files: [iconFile] } })
    fireEvent.click(fixture.view.getByRole("button", { name: "提交审核" }))

    await waitFor(() => expect(accepted).toEqual([summary.id]))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({
      package: packageFile,
      icon: iconFile,
      metadata: {
        version: "1.2.0",
        displayName: "Safe Skill",
        description: "A safe submitted Skill",
        category: "Developer Tools",
        tags: ["review", "automation"],
        license: "MIT",
        requiresApiKey: true,
        changeNotes: "Initial submission",
      },
    })
    expect(calls[0]?.key).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("prefills metadata but requires fresh change notes for a new version", () => {
    const view = render(() => (
      <SubmissionForm source={writer()} mode={{ kind: "version", initial: metadata }} onAccepted={() => undefined} />
    ))

    expect(view.getByRole("heading", { name: "提交新版本" })).toBeTruthy()
    expect(view.getByLabelText<HTMLInputElement>("版本号").value).toBe("1.2.0")
    expect(view.getByLabelText<HTMLInputElement>("Skill 名称").value).toBe("Safe Skill")
    expect(view.getByLabelText<HTMLTextAreaElement>("变更说明").value).toBe("")
  })

  test("disables while uploading and reuses the idempotency key after a network retry", async () => {
    const keys: string[] = []
    const accepted: string[] = []
    let resolveUpload: ((value: SkillMarketControl.AcceptedSubmission) => void) | undefined
    const source = writer((_input, key) => {
      keys.push(key)
      if (keys.length === 1) return Promise.reject(new TypeError("network unavailable"))
      return new Promise((resolve) => {
        resolveUpload = resolve
      })
    })
    const fixture = renderForm(source, (id) => accepted.push(id))
    fillMetadata(fixture.view)
    fireEvent.change(fixture.view.getByLabelText("Skill ZIP 包"), {
      target: { files: [new File(["zip"], "safe.zip", { type: "application/zip" })] },
    })

    fireEvent.click(fixture.view.getByRole("button", { name: "提交审核" }))
    expect(await fixture.view.findByText("上传失败，请检查网络后重试；内容未修改时会复用同一请求。")).toBeTruthy()
    fireEvent.click(fixture.view.getByRole("button", { name: "重试提交" }))
    expect((await fixture.view.findByRole("status")).textContent).toContain("正在上传")
    expect(fixture.view.getByRole("button", { name: "正在提交…" }).hasAttribute("disabled")).toBe(true)
    expect(keys[1]).toBe(keys[0])

    resolveUpload?.({ submission: summary })
    await waitFor(() => expect(accepted).toEqual([summary.id]))
  })

  test("submits revisions with optimistic concurrency and preserves files across a conflict", async () => {
    const calls: Array<{
      submissionID: string
      input: Parameters<SubmissionWriter["revise"]>[1]
      key: string
    }> = []
    const conflicts = { value: 0 }
    const accepted: string[] = []
    const source: SubmissionWriter = {
      create: () => Promise.reject(new Error("create must not be used for a revision")),
      revise: (submissionID, input, key) => {
        calls.push({ submissionID, input, key })
        if (calls.length === 1)
          return Promise.reject(new MarketControlError(409, "submission-conflict", "投稿已更新", "req_abcdef"))
        return Promise.resolve({ submission: summary })
      },
    }
    const packageFile = new File(["revision"], "safe-revision.zip", { type: "application/zip" })
    const view = render(() => (
      <SubmissionForm
        source={source}
        mode={{ kind: "revision", submissionID: summary.id, expectedVersion: 3, initial: metadata }}
        onAccepted={(id) => accepted.push(id)}
        onConflict={() => (conflicts.value += 1)}
      />
    ))
    fireEvent.input(view.getByLabelText("变更说明"), { target: { value: "Address review feedback" } })
    fireEvent.change(view.getByLabelText("Skill ZIP 包"), { target: { files: [packageFile] } })

    fireEvent.click(view.getByRole("button", { name: "提交审核" }))
    expect(await view.findByText("投稿已更新（请求编号：req_abcdef）")).toBeTruthy()
    expect(conflicts.value).toBe(1)
    expect(view.getByLabelText<HTMLInputElement>("Skill ZIP 包").files?.[0]).toBe(packageFile)
    fireEvent.click(view.getByRole("button", { name: "重试提交" }))

    await waitFor(() => expect(accepted).toEqual([summary.id]))
    expect(calls[1]).toMatchObject({
      submissionID: summary.id,
      input: {
        expectedVersion: 3,
        package: packageFile,
        metadata: { ...metadata, changeNotes: "Address review feedback" },
      },
    })
    expect(calls[1]?.key).not.toBe(calls[0]?.key)
  })
})

const summary = {
  id: "sub_abcdefgh",
  skillID: "safe-skill",
  owner: { employeeID: "E000001", displayName: "Contributor" },
  targetVersion: "1.2.0",
  status: "validating",
  currentRevision: 1,
  version: 1,
  risk: "unknown",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
} satisfies SkillMarketControl.SubmissionSummary

const metadata = {
  version: "1.2.0",
  displayName: "Safe Skill",
  description: "A safe submitted Skill",
  category: "Developer Tools",
  tags: ["review", "automation"],
  license: "MIT",
  requiresApiKey: true,
  changeNotes: "Initial submission",
} satisfies SkillMarketControl.SubmissionMetadata

function renderForm(source: SubmissionWriter, onAccepted: (id: string) => void = () => undefined) {
  return { view: render(() => <SubmissionForm source={source} onAccepted={onAccepted} />) }
}

function writer(create: SubmissionWriter["create"] = () => Promise.resolve({ submission: summary })): SubmissionWriter {
  return {
    create,
    revise: () => Promise.resolve({ submission: summary }),
  }
}

function fillMetadata(view: ReturnType<typeof render>, values: { version?: string } = {}) {
  const inputs = [
    ["版本号", values.version ?? "1.2.0"],
    ["Skill 名称", " Safe Skill "],
    ["简介", " A safe submitted Skill "],
    ["分类", " Developer Tools "],
    ["标签", "review, automation"],
    ["许可证（可选）", "MIT"],
    ["变更说明", " Initial submission "],
  ] as const
  inputs.forEach(([label, value]) => fireEvent.input(view.getByLabelText(label), { target: { value } }))
  fireEvent.click(view.getByLabelText("需要 API Key"))
}

function sizedFile(name: string, size: number, type: string) {
  const file = new File(["content"], name, { type })
  Object.defineProperty(file, "size", { value: size })
  return file
}
