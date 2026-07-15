import { expect, test } from "bun:test"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import type { ParentProps } from "solid-js"
import { DesktopSkillActions, desktopActionState } from "./desktop-actions"
import { DesktopSkillMarketProvider } from "./desktop-provider"
import { SkillMarketProvider } from "./provider"
import type { SkillMarketActions, SkillMarketDataSource } from "./types"

const sha256 = "a".repeat(64)

test("installs a safe Skill in one step", async () => {
  const calls: SkillMarket.InstallRequest[] = []
  const view = renderActions(detail(), {
    install: async (input) => {
      calls.push(input)
      return operation()
    },
  })

  await userEvent.click(view.getByRole("button", { name: "安装" }))
  await waitFor(() => expect(calls).toEqual([expect.objectContaining({ id: "code-review", riskConfirmed: undefined })]))
})

test("requires explicit second confirmation for a risky install", async () => {
  const calls: SkillMarket.InstallRequest[] = []
  const view = renderActions(
    detail({
      risk: "warning",
      riskReason: "检测到网络访问",
      securityReports: [{ provider: "Scanner", verdict: "warning", summary: "会访问外部网络" }],
    }),
    {
      install: async (input) => {
        calls.push(input)
        return operation()
      },
    },
  )

  await userEvent.click(view.getByRole("button", { name: "安装" }))
  expect(view.getByText("会访问外部网络")).toBeTruthy()
  expect((view.getByRole("button", { name: "确认风险并安装" }) as HTMLButtonElement).disabled).toBe(true)
  await userEvent.click(view.getByRole("checkbox", { name: "我已阅读并接受该 Skill 的风险" }))
  await userEvent.click(view.getByRole("button", { name: "确认风险并安装" }))
  await waitFor(() => expect(calls).toEqual([expect.objectContaining({ riskConfirmed: true })]))
})

test("does not mutate on uninstall until confirmation is accepted", async () => {
  const calls: string[] = []
  const record = detail({ installedVersion: "1.0.0" })
  const view = renderActions(record, {
    installed: [installed()],
    uninstall: async (key) => {
      calls.push(`${key.source}:${key.id}`)
    },
  })

  await userEvent.click(view.getByRole("button", { name: "卸载" }))
  expect(calls).toEqual([])
  await userEvent.click(view.getByRole("button", { name: "确认卸载" }))
  await waitFor(() => expect(calls).toEqual(["skillhub:code-review"]))
})

test("derives update and refresh failure states from installed inventory", () => {
  expect(desktopActionState(detail(), installed({ updateAvailable: true }))).toEqual({
    type: "update-available",
    installed: "1.0.0",
    available: "1.0.0",
  })
  expect(desktopActionState(detail(), installed({ loadState: "refresh-failed" }))).toEqual({
    type: "refresh-failed",
    version: "1.0.0",
  })
})

function renderActions(
  record: SkillMarket.Detail,
  input: {
    installed?: readonly SkillMarket.Installed[]
    install?: (request: SkillMarket.InstallRequest) => Promise<SkillMarket.OperationResult>
    uninstall?: (key: { source: SkillMarket.Source; id: string }) => Promise<void>
  },
) {
  const source = {
    list: async () => page(),
    facets: async () => facets(),
    detail: async () => record,
    versions: async () => record.versions,
    installed: async () => input.installed ?? [],
    updates: async () => [],
  } satisfies SkillMarketDataSource
  const actions = {
    kind: "desktop",
    install: input.install ?? (async () => operation()),
    update: async () => operation(),
    uninstall: input.uninstall ?? (async () => undefined),
    refresh: async () => undefined,
  } satisfies SkillMarketActions
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = (props: ParentProps) => (
    <QueryClientProvider client={client}>
      <SkillMarketProvider source={source} actions={actions}>
        <DesktopSkillMarketProvider>{props.children}</DesktopSkillMarketProvider>
      </SkillMarketProvider>
    </QueryClientProvider>
  )
  return render(() => <DesktopSkillActions detail={record} />, { wrapper: Wrapper })
}

function detail(input: Partial<SkillMarket.Detail> = {}): SkillMarket.Detail {
  return {
    id: "code-review",
    source: "skillhub",
    sourceUrl: "https://skillhub.cn/skills/code-review",
    name: "Code Review",
    description: "Review code",
    categories: ["engineering"],
    tags: ["review"],
    requiresApiKey: false,
    risk: "safe",
    version: "1.0.0",
    updatedAt: "2026-07-15T00:00:00.000Z",
    downloads: 1,
    favorites: 0,
    score: 1,
    featured: false,
    enterprise: false,
    delisted: false,
    readme: "# Code Review",
    author: { name: "Ruying" },
    versions: [{ version: "1.0.0", publishedAt: "2026-07-15T00:00:00.000Z", sha256, size: 1 }],
    securityReports: [],
    package: { url: "https://example.com/code-review.zip", sha256, size: 1, files: [] },
    publicDetailUrl: "https://skillhub.cn/skills/code-review",
    ...input,
  }
}

function installed(input: Partial<SkillMarket.Installed> = {}): SkillMarket.Installed {
  return {
    source: "skillhub",
    id: "code-review",
    name: "Code Review",
    version: "1.0.0",
    installedAt: "2026-07-15T00:00:00.000Z",
    updateAvailable: false,
    loadState: "ready",
    ...input,
  }
}

function operation(): SkillMarket.OperationResult {
  return { installed: installed(), changed: true }
}

function page(): SkillMarket.Page {
  return {
    revision: "revision",
    sourceStatus: { skillhub: "fresh", enterprise: "fresh" },
    total: 0,
    page: 1,
    limit: 30,
    items: [],
  }
}

function facets(): SkillMarket.Facets {
  return {
    revision: "revision",
    sourceStatus: { skillhub: "fresh", enterprise: "fresh" },
    sources: [],
    categories: [],
    requiresApiKey: { yes: 0, no: 0 },
  }
}
