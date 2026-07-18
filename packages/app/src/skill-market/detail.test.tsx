import { beforeEach, expect, test } from "bun:test"
import { render, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { installPrompt, SkillMarketDetail } from "./detail"
import { SkillMarketProvider } from "./provider"
import type { SkillMarketActions, SkillMarketDataSource } from "./types"

const detail = {
  id: "code-review",
  source: "skillhub",
  sourceUrl: "https://clawhub.ai/example/code-review",
  name: "Code Review",
  description: "审查代码并发现风险",
  iconUrl: "https://cdn.example.com/code-review.png",
  categories: ["代码质量"],
  tags: ["review", "quality"],
  requiresApiKey: false,
  risk: "warning",
  version: "1.2.0",
  updatedAt: "2026-07-15T01:00:00.000Z",
  downloads: 1200,
  favorites: 80,
  score: 98.6,
  featured: true,
  enterprise: false,
  delisted: false,
  readme:
    '# Safe\n<script>bad()</script><a href="javascript:bad()">bad</a><a href="https://example.com/docs">docs</a><img src="http://example.com/bad.png"><img src="https://example.com/good.png">',
  license: "MIT",
  author: { name: "SkillHub Author", url: "https://example.com/author" },
  versions: [
    {
      version: "1.2.0",
      publishedAt: "2026-07-15T01:00:00.000Z",
      sha256: "a".repeat(64),
      size: 2048,
    },
  ],
  securityReports: [
    {
      provider: "Ruying Scanner",
      verdict: "warning",
      summary: "需要网络访问权限",
      reportUrl: "https://security.example.com/report/code-review",
    },
  ],
  riskReason: "此 Skill 会调用外部服务",
  package: {
    url: "https://cdn.example.com/code-review.zip",
    sha256: "a".repeat(64),
    size: 2048,
    files: [{ path: "SKILL.md", sha256: "b".repeat(64), size: 1024 }],
  },
  publicDetailUrl: "https://skillhub.cn/skills/code-review",
} satisfies SkillMarket.Detail

const expectedPrompt = `请安装并使用这个 Skill：Code Review
内网详情：http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/skills/skillhub/code-review
内网下载：https://oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/app-platform-test/ai-coding/ruying-code/skill-market-test/packages/${"a".repeat(64)}.zip
版本：1.2.0
SHA-256：${"a".repeat(64)}
要求：仅使用上述内网地址下载，并在安装前校验 SHA-256。`

function source(value: SkillMarket.Detail = detail): SkillMarketDataSource {
  return {
    list: async () => Promise.reject(new Error("unused")),
    facets: async () => Promise.reject(new Error("unused")),
    detail: async () => value,
    versions: async () => value.versions,
  }
}

function renderDetail(data: SkillMarketDataSource, actions: SkillMarketActions) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(() => (
    <QueryClientProvider client={client}>
      <SkillMarketProvider source={data} actions={actions}>
        <SkillMarketDetail skill={{ source: "skillhub", id: "code-review" }} onBack={() => undefined} />
      </SkillMarketProvider>
    </QueryClientProvider>
  ))
}

beforeEach(() => {
  document.body.innerHTML = ""
})

test("formats an internal-only install prompt", () => {
  const value = installPrompt(detail, {
    detailUrl:
      "http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/skills/skillhub/code-review",
    downloadUrl: `https://oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/app-platform-test/ai-coding/ruying-code/skill-market-test/packages/${"a".repeat(64)}.zip`,
  })

  expect(value).toBe(expectedPrompt)
  expect(value).not.toContain("skillhub.cn")
  expect(value).not.toContain("clawhub.ai")
  expect(value).not.toContain(detail.sourceUrl)
  expect(value).not.toContain(detail.publicDetailUrl)
})

test("sanitizes markdown and exposes only web copy and download actions", async () => {
  const copied: string[] = []
  const downloaded: string[] = []
  const view = renderDetail(source(), {
    kind: "web",
    prompt: () => expectedPrompt,
    copyPrompt: async (value) => {
      copied.push(value)
    },
    download: async (value) => {
      downloaded.push(value.package.url)
    },
  })

  expect(await view.findByRole("heading", { name: detail.name, level: 1 })).toBeTruthy()
  expect(view.container.querySelector("script")).toBeNull()
  expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull()
  expect(view.container.querySelector('img[src^="http:"]')).toBeNull()
  const link = view.getByRole("link", { name: "docs" })
  expect(link.getAttribute("target")).toBe("_blank")
  expect(link.getAttribute("rel")).toBe("noopener noreferrer")
  await userEvent.click(view.getByRole("button", { name: "复制安装 Prompt" }))
  await userEvent.click(view.getByRole("button", { name: "下载 ZIP" }))

  expect(copied).toEqual([expectedPrompt])
  expect(downloaded).toEqual([detail.package.url])
  expect(view.queryByRole("button", { name: "安装" })).toBeNull()
})

test("reports prompt copy progress and success", async () => {
  const copy = Promise.withResolvers<void>()
  const view = renderDetail(source(), {
    kind: "web",
    prompt: () => expectedPrompt,
    copyPrompt: () => copy.promise,
    download: async () => undefined,
  })

  await view.findByRole("heading", { name: detail.name, level: 1 })
  await userEvent.click(view.getByRole("button", { name: "复制安装 Prompt" }))
  const pending = view.getByRole("button", { name: "正在复制…" })
  expect(pending.hasAttribute("disabled")).toBe(true)

  copy.resolve()
  expect(await view.findByRole("button", { name: "已复制" })).toBeTruthy()
  expect(view.getByRole("status").textContent).toContain("安装 Prompt 已复制到剪贴板")
})

test("offers the complete prompt when automatic copy fails", async () => {
  const denied = Promise.reject(new Error("denied"))
  void denied.catch(() => undefined)
  const copied: string[] = []
  const view = renderDetail(source(), {
    kind: "web",
    prompt: () => expectedPrompt,
    copyPrompt: (value) => {
      copied.push(value)
      return denied
    },
    download: async () => undefined,
  })

  await view.findByRole("heading", { name: detail.name, level: 1 })
  await userEvent.click(view.getByRole("button", { name: "复制安装 Prompt" }))
  expect((await view.findByRole("alert")).textContent).toContain("自动复制失败")
  expect(copied).toEqual([expectedPrompt])
  expect((view.getByRole("textbox", { name: "安装 Prompt" }) as HTMLTextAreaElement).value).toBe(expectedPrompt)
})

test("supports keyboard tab navigation across overview versions and security", async () => {
  const view = renderDetail(source(), {
    kind: "web",
    prompt: () => expectedPrompt,
    copyPrompt: async () => undefined,
    download: async () => undefined,
  })
  const overview = await view.findByRole("tab", { name: "概述" })

  overview.focus()
  await userEvent.keyboard("{ArrowRight}")
  expect(view.getByRole("tab", { name: "版本" }).getAttribute("aria-selected")).toBe("true")
  expect(await view.findByText("1.2.0", { exact: true })).toBeTruthy()
  await userEvent.keyboard("{ArrowRight}")
  expect(view.getByRole("tab", { name: "安全报告" }).getAttribute("aria-selected")).toBe("true")
  expect(view.getByText("需要网络访问权限")).toBeTruthy()
  expect(view.getByText("此 Skill 会调用外部服务")).toBeTruthy()
})

test("shows attribution and a delisted warning", async () => {
  const view = renderDetail(source({ ...detail, delisted: true, risk: "danger" }), {
    kind: "web",
    prompt: () => expectedPrompt,
    copyPrompt: async () => undefined,
    download: async () => undefined,
  })

  expect(await view.findByText("此 Skill 已从来源下架")).toBeTruthy()
  expect(view.getByText("高风险")).toBeTruthy()
  expect(view.getByRole("link", { name: "SkillHub Author" }).getAttribute("href")).toBe(detail.author.url)
  expect(view.getByRole("link", { name: "查看原始来源" }).getAttribute("href")).toBe(detail.sourceUrl)
})

test("shows approved community attribution without private employee data", async () => {
  const community = {
    ...detail,
    source: "community",
    sourceUrl: "https://market.example.com/skills/community/code-review",
    submittedBy: { displayName: "如影用户" },
    reviewedAt: "2026-07-15T02:00:00.000Z",
    publicDetailUrl: "https://market.example.com/skills/community/code-review",
  } satisfies SkillMarket.Detail
  const view = renderDetail(source(community), {
    kind: "web",
    prompt: () => expectedPrompt,
    copyPrompt: async () => undefined,
    download: async () => undefined,
  })

  expect(await view.findByText("用户投稿")).toBeTruthy()
  expect(view.getByText("如影用户")).toBeTruthy()
  expect(view.getByText("审核时间")).toBeTruthy()
  expect(view.container.textContent).not.toContain("employee")
})

test("renders loading and unavailable states", async () => {
  let resolve: ((value: SkillMarket.Detail) => void) | undefined
  const pending = new Promise<SkillMarket.Detail>((done) => {
    resolve = done
  })
  const loading = renderDetail(
    { ...source(), detail: async () => pending },
    {
      kind: "web",
      prompt: () => expectedPrompt,
      copyPrompt: async () => undefined,
      download: async () => undefined,
    },
  )

  expect(loading.getByRole("status").textContent).toContain("正在加载")
  resolve?.(detail)
  await loading.findByRole("heading", { name: detail.name, level: 1 })

  const unavailable = renderDetail(
    { ...source(), detail: async () => Promise.reject(new Error("not found")) },
    {
      kind: "web",
      prompt: () => expectedPrompt,
      copyPrompt: async () => undefined,
      download: async () => undefined,
    },
  )
  await waitFor(() => expect(unavailable.getByRole("alert").textContent).toContain("不存在或已下架"))
})
