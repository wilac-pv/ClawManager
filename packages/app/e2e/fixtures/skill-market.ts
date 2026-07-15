import type { Page, Route } from "@playwright/test"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { fixture as base } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

const sha256 = "a".repeat(64)

export async function setupSkillMarketFixture(page: Page, risk: SkillMarket.Risk = "safe") {
  const state = {
    installed: [] as SkillMarket.Installed[],
    mutations: [] as string[],
    processRestartCount: 0,
  }
  await mockOpenCodeServer(page, {
    directory: base.directory,
    project: base.project,
    provider: base.provider,
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/provider/ruying/session" && route.request().method() === "GET") {
      return json(route, {
        loggedIn: true,
        user: { employeeId: "E0001", displayName: "测试用户", email: "tester@example.com" },
      })
    }
    if (url.pathname === "/api/skill/market/facets") {
      return json(route, {
        revision: "revision",
        sourceStatus: { skillhub: "fresh", enterprise: "fresh" },
        sources: [{ value: "skillhub", count: 1 }],
        categories: [{ value: "engineering", count: 1 }],
        requiresApiKey: { yes: 0, no: 1 },
      })
    }
    if (url.pathname === "/api/skill/market/skills") {
      return json(route, {
        revision: "revision",
        sourceStatus: { skillhub: "fresh", enterprise: "fresh" },
        total: 1,
        page: 1,
        limit: 30,
        items: [{ ...summary(risk), installedVersion: state.installed[0]?.version }],
      })
    }
    if (url.pathname === "/api/skill/market/skills/skillhub/code-review") return json(route, detail(risk))
    if (url.pathname === "/api/skill/market/installed") return json(route, state.installed)
    if (url.pathname === "/api/skill/market/updates") return json(route, [])
    if (url.pathname === "/api/skill/market/install" && route.request().method() === "POST") {
      state.mutations.push("install")
      state.installed = [installed()]
      return json(route, { installed: state.installed[0], changed: true })
    }
    if (url.pathname === "/api/skill/market/update" && route.request().method() === "POST") {
      state.mutations.push("update")
      state.installed = [installed()]
      return json(route, { installed: state.installed[0], changed: true })
    }
    if (url.pathname === "/api/skill/market/install/skillhub/code-review" && route.request().method() === "DELETE") {
      state.mutations.push("uninstall")
      state.installed = []
      return route.fulfill({ status: 204 })
    }
    if (url.pathname === "/api/skill/market/install/skillhub/code-review/refresh") {
      state.mutations.push("refresh")
      return route.fulfill({ status: 204 })
    }
    return route.fallback()
  })
  await page.addInitScript((directory) => {
    ;(window as unknown as { process: { env: Record<string, string> } }).process = { env: {} }
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: false } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, base.directory)
  return state
}

function summary(risk: SkillMarket.Risk): SkillMarket.Summary {
  return {
    id: "code-review",
    source: "skillhub",
    sourceUrl: "https://skillhub.cn/skills/code-review",
    name: "Code Review",
    description: "Review code and find risks",
    categories: ["engineering"],
    tags: ["review"],
    requiresApiKey: false,
    risk,
    version: "1.0.0",
    updatedAt: "2026-07-15T00:00:00.000Z",
    downloads: 100,
    favorites: 1,
    score: 9.8,
    featured: true,
    enterprise: false,
    delisted: false,
  }
}

function detail(risk: SkillMarket.Risk): SkillMarket.Detail {
  return {
    ...summary(risk),
    readme: "# Code Review\n\nA useful review Skill.",
    author: { name: "Ruying" },
    versions: [{ version: "1.0.0", publishedAt: "2026-07-15T00:00:00.000Z", sha256, size: 100 }],
    securityReports:
      risk === "safe" ? [] : [{ provider: "Scanner", verdict: risk, summary: "This Skill can access the network." }],
    riskReason: risk === "safe" ? undefined : "Network access detected.",
    package: {
      url: "https://example.com/code-review.zip",
      sha256,
      size: 100,
      files: [{ path: "SKILL.md", sha256, size: 100 }],
    },
    publicDetailUrl: "https://skillhub.cn/skills/code-review",
  }
}

function installed(): SkillMarket.Installed {
  return {
    source: "skillhub",
    id: "code-review",
    name: "Code Review",
    version: "1.0.0",
    installedAt: "2026-07-15T00:00:00.000Z",
    updateAvailable: false,
    loadState: "ready",
  }
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}
