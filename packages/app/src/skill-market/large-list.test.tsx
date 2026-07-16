import { expect, test } from "bun:test"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render, waitFor } from "@solidjs/testing-library"
import { SkillMarketList } from "./list"
import { SkillMarketProvider } from "./provider"
import type { SkillMarketDataSource } from "./types"

test("requests one server page and renders at most 30 rows for an 80000 item catalog", async () => {
  const calls: SkillMarket.PageQuery[] = []
  const source = {
    list: async (query) => {
      calls.push(query)
      return {
        revision: "revision",
        sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
        total: 80_000,
        page: 1,
        limit: 30,
        items: Array.from({ length: 30 }, (_, index) => summary(index)),
      } satisfies SkillMarket.Page
    },
    facets: async () => ({
      revision: "revision",
      sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
      sources: [],
      categories: [],
      requiresApiKey: { yes: 0, no: 0 },
    }),
    detail: async () => Promise.reject(new Error("unused")),
    versions: async () => [],
  } satisfies SkillMarketDataSource
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(() => (
    <QueryClientProvider client={client}>
      <SkillMarketProvider
        source={source}
        actions={{ kind: "web", copyPrompt: async () => undefined, download: async () => undefined }}
      >
        <SkillMarketList onOpen={() => undefined} />
      </SkillMarketProvider>
    </QueryClientProvider>
  ))

  await waitFor(() => expect(calls).toEqual([expect.objectContaining({ page: 1, limit: 30 })]))
  expect(await view.findByText(/80,000/)).toBeTruthy()
  expect(view.container.querySelectorAll(".ruying-skill-market__virtual-row").length).toBeLessThanOrEqual(30)
})

function summary(index: number): SkillMarket.Summary {
  return {
    id: `skill-${index}`,
    source: "skillhub",
    sourceUrl: `https://skillhub.cn/skills/skill-${index}`,
    name: `Skill ${index}`,
    description: "A useful Skill",
    categories: ["engineering"],
    tags: [],
    requiresApiKey: false,
    risk: "safe",
    version: "1.0.0",
    updatedAt: "2026-07-15T00:00:00.000Z",
    downloads: index,
    favorites: 0,
    score: 1,
    featured: false,
    enterprise: false,
    delisted: false,
  }
}
