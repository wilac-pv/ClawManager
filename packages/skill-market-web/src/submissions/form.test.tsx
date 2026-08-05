import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import type { JSX } from "solid-js"
import { MarketControlError } from "../control-data-source"
import type { SubmissionWriter } from "./form"
import { SubmissionForm } from "./form"

afterEach(() => cleanup())

describe("submission form", () => {
  test("uses Chinese context labels for submission sections", () => {
    const fixture = renderForm(writer())

    expect(fixture.view.container.textContent).not.toContain("Skill package")
    expect(fixture.view.container.textContent).not.toContain("Publication scope")
    expect(fixture.view.container.textContent).toContain("Skill 包")
    expect(fixture.view.container.textContent).toContain("发布范围")
  })

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
      target: "company",
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

  test("uploads to personal space when selected", async () => {
    const calls: Array<Parameters<SubmissionWriter["create"]>[0]> = []
    const source = writer((input) => {
      calls.push(input)
      return Promise.resolve({ submission: { ...summary, target: "personal", status: "validating" } })
    })
    const fixture = renderForm(source)
    fireEvent.click(fixture.view.getByRole("radio", { name: /个人空间/ }))
    fillMetadata(fixture.view)
    fireEvent.change(fixture.view.getByLabelText("Skill ZIP 包"), {
      target: { files: [new File(["zip"], "personal.zip", { type: "application/zip" })] },
    })
    fireEvent.click(fixture.view.getByRole("button", { name: "上传到个人空间" }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.target).toBe("personal")
  })

  test("submits a reviewed multi-group audience from managed active groups", async () => {
    const calls: Array<Parameters<SubmissionWriter["create"]>[0]> = []
    const source = writer((input) => {
      calls.push(input)
      return Promise.resolve({ submission: { ...summary, target: "groups", status: "validating" } })
    })
    const fixture = renderInRouter(() => (
      <SubmissionForm
        source={source}
        groups={{
          list: () =>
            Promise.resolve({
              managed: [
                group("grp_aurora1", "Project Aurora"),
                group("grp_atlas01", "Project Atlas"),
                group("grp_disabled1", "Disabled", "disabled"),
              ],
              joined: [group("grp_joined01", "Joined only")],
            }),
        }}
        department={{ id: "dep_platform", name: "Platform" }}
        onAccepted={() => undefined}
      />
    ))
    fireEvent.click(fixture.getByRole("radio", { name: /指定小组/ }))
    fireEvent.click(await fixture.findByRole("checkbox", { name: "Project Aurora" }))
    fireEvent.click(fixture.getByRole("checkbox", { name: "Project Atlas" }))
    expect(fixture.queryByRole("checkbox", { name: "Disabled" })).toBeNull()
    expect(fixture.queryByRole("checkbox", { name: "Joined only" })).toBeNull()
    fillMetadata(fixture)
    fireEvent.change(fixture.getByLabelText("Skill ZIP 包"), {
      target: { files: [new File(["zip"], "groups.zip", { type: "application/zip" })] },
    })
    fireEvent.click(fixture.getByRole("button", { name: "提交审核" }))

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_aurora1", "grp_atlas01"] },
    })
  })

  test("disables department sharing when the session has no department", () => {
    const view = renderInRouter(() => <SubmissionForm source={writer()} onAccepted={() => undefined} />)

    expect(view.getByRole("radio", { name: /本部门/ }).hasAttribute("disabled")).toBe(true)
    expect(view.getByText("当前账号没有部门信息，无法选择本部门。")).toBeTruthy()
  })

  test("keeps the personal-space cancel link under the configured base path", () => {
    const basePath = "/ai-coding/ruying-code/skill-market/"
    const view = renderInRouter(
      () => (
        <SubmissionForm
          source={writer()}
          mode={{ kind: "create", target: "personal" }}
          onAccepted={() => undefined}
        />
      ),
      `${basePath}submissions/new?target=personal`,
      basePath,
    )

    expect(view.getByRole("link", { name: "取消" }).getAttribute("href")).toBe(`${basePath}personal`)
  })

  test("submits when randomUUID is unavailable on private HTTP", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID")
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined })
    const keys: string[] = []

    try {
      const fixture = renderForm(
        writer((_input, key) => {
          keys.push(key)
          return Promise.resolve({ submission: summary })
        }),
      )
      fillMetadata(fixture.view)
      fireEvent.change(fixture.view.getByLabelText("Skill ZIP 包"), {
        target: { files: [new File(["zip"], "safe.zip", { type: "application/zip" })] },
      })
      fireEvent.click(fixture.view.getByRole("button", { name: "提交审核" }))

      await waitFor(() => expect(keys).toHaveLength(1))
      expect(keys[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    } finally {
      if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor)
      if (!descriptor) delete (crypto as { randomUUID?: Crypto["randomUUID"] }).randomUUID
    }
  })

  test("prefills metadata but requires fresh change notes for a new version", () => {
    const view = renderInRouter(() => (
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
    const view = renderInRouter(() => (
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
  return { view: renderInRouter(() => <SubmissionForm source={source} onAccepted={onAccepted} />) }
}

function renderInRouter(component: () => JSX.Element, path = "/submissions/new", basePath?: string) {
  const history = createMemoryHistory()
  history.set({ value: path, replace: true })
  return render(() => (
    <MemoryRouter base={basePath?.replace(/\/$/, "")} history={history}>
      <Route path="*" component={component} />
    </MemoryRouter>
  ))
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

function group(
  id: SkillMarketControl.GroupID,
  name: string,
  status: SkillMarketControl.MarketGroup["status"] = "active",
): SkillMarketControl.MarketGroup {
  return {
    id,
    name,
    ownerEmployeeID: "E000001",
    status,
    version: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  }
}
