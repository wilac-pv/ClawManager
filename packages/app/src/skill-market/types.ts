import type { SkillMarket } from "@opencode-ai/schema/skill-market"

export type SkillKey = {
  source: SkillMarket.Source
  id: string
}

export type SkillMarketDataSource = {
  list: (query: SkillMarket.PageQuery, signal?: AbortSignal) => Promise<SkillMarket.Page>
  facets: (signal?: AbortSignal) => Promise<SkillMarket.Facets>
  detail: (key: SkillKey, signal?: AbortSignal) => Promise<SkillMarket.Detail>
  versions: (key: SkillKey, signal?: AbortSignal) => Promise<readonly SkillMarket.Version[]>
  download?: (key: SkillKey, signal?: AbortSignal) => Promise<SkillMarket.Download>
  installed?: (signal?: AbortSignal) => Promise<readonly SkillMarket.Installed[]>
  updates?: (signal?: AbortSignal) => Promise<readonly SkillMarket.Installed[]>
  expertPackages?: {
    list: (
      query: { query?: string; scene?: SkillMarket.ExpertPackageScene; page: number; limit: number },
      signal?: AbortSignal,
    ) => Promise<SkillMarket.ExpertPackagePage>
    detail: (slug: string, signal?: AbortSignal) => Promise<SkillMarket.ExpertPackageDetail>
  }
}

export type SkillFavoriteActions = {
  active: (key: SkillKey) => boolean
  pending: (key: SkillKey) => boolean
  toggle: (key: SkillKey) => void
}

export type SkillMarketActions =
  | {
      kind: "web"
      prompt: (detail: SkillMarket.Detail) => string
      copyPrompt: (prompt: string) => Promise<void>
      download: (detail: SkillMarket.Detail) => Promise<void>
    }
  | {
      kind: "desktop"
      install: (input: SkillMarket.InstallRequest) => Promise<SkillMarket.OperationResult>
      update: (input: SkillMarket.InstallRequest) => Promise<SkillMarket.OperationResult>
      uninstall: (key: SkillKey) => Promise<void>
      refresh: (key: SkillKey) => Promise<void>
    }
