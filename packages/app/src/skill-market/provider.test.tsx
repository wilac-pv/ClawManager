import { expect, test } from "bun:test"
import { render } from "@solidjs/testing-library"
import { SkillMarketProvider, useSkillMarket } from "./provider"
import type { SkillMarketActions, SkillMarketDataSource } from "./types"

test("provides the selected data source and web actions", () => {
  const source = {
    list: async () => ({
      revision: "revision",
      sourceStatus: { skillhub: "fresh" as const, enterprise: "fresh" as const, community: "fresh" as const },
      total: 0,
      page: 1,
      limit: 30,
      items: [],
    }),
    facets: async () => ({
      revision: "revision",
      sourceStatus: { skillhub: "fresh" as const, enterprise: "fresh" as const, community: "fresh" as const },
      sources: [],
      categories: [],
      requiresApiKey: { yes: 0, no: 0 },
    }),
    detail: async () => Promise.reject(new Error("unused")),
    versions: async () => [],
  } satisfies SkillMarketDataSource
  const actions = {
    kind: "web",
    prompt: () => "",
    copyPrompt: async () => undefined,
    download: async () => undefined,
  } satisfies SkillMarketActions
  const Probe = () => (
    <div>
      {useSkillMarket().actions.kind}:{useSkillMarket().source === source ? "source" : "wrong"}
    </div>
  )
  const view = render(() => (
    <SkillMarketProvider source={source} actions={actions}>
      <Probe />
    </SkillMarketProvider>
  ))

  expect(view.getByText("web:source")).toBeTruthy()
})

test("fails clearly outside a provider", () => {
  expect(() => render(() => <div>{useSkillMarket().actions.kind}</div>)).toThrow("SkillMarketProvider is missing")
})
