import { beforeEach, expect, test } from "bun:test"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { installPrompt, SkillMarketDetail } from "./detail"
import { SkillMarketProvider } from "./provider"
import type { SkillMarketActions, SkillMarketDataSource } from "./types"

const detail = {
  id: "code-review",
  source: "skillhub",
  sourceUrl: "https://skillhub.cn/skills/code-review",
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
  score: 100000,
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
  publicDetailUrl: "https://ruying.example.com/skills/skillhub/code-review",
} satisfies SkillMarket.Detail

const links = {
  detailUrl: "http://10.246.13.226:4211/skills/skillhub/code-review",
  downloadUrl: "http://10.246.13.226:4211/v1/catalog/skills/skillhub/code-review/package",
}
const prompt = `请安装并使用这个 Skill：Code Review
内网详情：http://10.246.13.226:4211/skills/skillhub/code-review
内网下载：http://10.246.13.226:4211/v1/catalog/skills/skillhub/code-review/package
版本：1.2.0
SHA-256：${detail.package.sha256}
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

test("builds the complete install prompt from explicit links", () => {
  expect(installPrompt(detail, links)).toBe(prompt)
})

test("sanitizes markdown and exposes only web copy and download actions", async () => {
  const copied: string[] = []
  const downloaded: string[] = []
  const view = renderDetail(source(), {
    kind: "web",
    prompt: () => prompt,
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

  expect(copied).toEqual([prompt])
  expect(downloaded).toEqual([detail.package.url])
  expect(view.queryByRole("button", { name: "安装" })).toBeNull()
})

test("reports prompt copy progress and success", async () => {
  const copy = Promise.withResolvers<void>()
  const view = renderDetail(source(), {
    kind: "web",
    prompt: () => prompt,
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
  const actions = {
    kind: "web",
    prompt: (_detail: SkillMarket.Detail) => prompt,
    copyPrompt: () => denied,
    download: async () => undefined,
  } satisfies SkillMarketActions
  const view = renderDetail(source(), actions)

  await view.findByRole("heading", { name: detail.name, level: 1 })
  await userEvent.click(view.getByRole("button", { name: "复制安装 Prompt" }))
  expect((await view.findByRole("alert")).textContent).toContain("自动复制失败")
  expect(view.getByRole<HTMLTextAreaElement>("textbox", { name: "安装 Prompt" }).value).toBe(actions.prompt(detail))
})

test("supports keyboard tab navigation across overview versions and security", async () => {
  const view = renderDetail(source(), {
    kind: "web",
    prompt: () => prompt,
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
    prompt: () => prompt,
    copyPrompt: async () => undefined,
    download: async () => undefined,
  })

  expect(await view.findByText("此 Skill 已从来源下架")).toBeTruthy()
  expect(view.getByText("高风险")).toBeTruthy()
  expect(view.getByRole("link", { name: "SkillHub Author" }).getAttribute("href")).toBe(detail.author.url)
  expect(view.queryByRole("link", { name: "查看原始来源" })).toBeNull()
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
    prompt: () => prompt,
    copyPrompt: async () => undefined,
    download: async () => undefined,
  })

  expect(await view.findByText("用户投稿")).toBeTruthy()
  expect(view.getByText("如影用户")).toBeTruthy()
  expect(view.getByText("审核时间")).toBeTruthy()
  expect(view.container.textContent).not.toContain("employee")
})

test("labels pending, evaluated, and community scores without ranking weights", async () => {
  const view = renderDetail(source(), {
    kind: "web",
    prompt: () => prompt,
    copyPrompt: async () => undefined,
    download: async () => undefined,
  })

  await view.findByRole("heading", { name: detail.name, level: 1 })
  expect(view.getByText("待评分")).toBeTruthy()
  expect(view.queryByText(/100000/)).toBeNull()
  cleanup()

  const scored = renderDetail(source({ ...detail, evaluationScore: 4.45 }), {
    kind: "web",
    prompt: () => prompt,
    copyPrompt: async () => undefined,
    download: async () => undefined,
  })

  await scored.findByRole("heading", { name: detail.name, level: 1 })
  expect(scored.getByText("4.5/5")).toBeTruthy()
  cleanup()

  const community = renderDetail(
    source({
      ...detail,
      source: "community",
      sourceUrl: "https://market.example.com/skills/community/code-review",
      publicDetailUrl: "https://market.example.com/skills/community/code-review",
    }),
    {
      kind: "web",
      prompt: () => prompt,
      copyPrompt: async () => undefined,
      download: async () => undefined,
    },
  )

  await community.findByRole("heading", { name: detail.name, level: 1 })
  expect(community.getByText("未评分")).toBeTruthy()
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
      prompt: () => prompt,
      copyPrompt: async () => undefined,
      download: async () => undefined,
    },
  )

  expect(loading.getByRole("status").textContent).toContain("正在加载")
  resolve?.(detail)
  await loading.findByRole("heading", { name: detail.name, level: 1 })

  const unavailable = renderDetail(
    { ...source(), detail: async () => Promise.reject(new Error("not found")) },
    { kind: "web", prompt: () => prompt, copyPrompt: async () => undefined, download: async () => undefined },
  )
  await waitFor(() => expect(unavailable.getByRole("alert").textContent).toContain("不存在或已下架"))
})
