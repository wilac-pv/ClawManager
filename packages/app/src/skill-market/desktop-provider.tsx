import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { createContext, createMemo, type ParentProps, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { useSkillMarket } from "./provider"
import { skillMarketErrorMessage, type SkillMarketErrorKey } from "./errors"
import type { SkillKey } from "./types"

export type DesktopOperation = "install" | "update" | "uninstall" | "refresh"

const DesktopSkillMarketContext = createContext<{
  installed: () => readonly SkillMarket.Installed[]
  item: (key: SkillKey) => SkillMarket.Installed | undefined
  pending: (key: SkillKey) => DesktopOperation | undefined
  install: (detail: SkillMarket.Detail, riskConfirmed: boolean) => Promise<SkillMarket.OperationResult>
  update: (detail: SkillMarket.Detail, riskConfirmed: boolean) => Promise<SkillMarket.OperationResult>
  uninstall: (key: SkillKey) => Promise<void>
  refresh: (key: SkillKey) => Promise<void>
  errorMessage: (error: unknown) => string
}>()

export function DesktopSkillMarketProvider(props: ParentProps<{ translate?: (key: SkillMarketErrorKey) => string }>) {
  const market = useSkillMarket()
  const actions = market.actions.kind === "desktop" ? market.actions : undefined
  const client = useQueryClient()
  const [pending, setPending] = createStore<Record<string, DesktopOperation | undefined>>({})
  const installed = createQuery(() => ({
    queryKey: ["skill-market", "installed"] as const,
    queryFn: ({ signal }) => market.source.installed?.(signal) ?? Promise.resolve([]),
    enabled: market.actions.kind === "desktop",
    staleTime: 5_000,
  }))
  const byKey = createMemo(() => new Map((installed.data ?? []).map((item) => [skillKey(item), item] as const)))
  const invalidate = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["skill-market", "installed"] }),
      client.invalidateQueries({ queryKey: ["skill-market", "updates"] }),
      client.invalidateQueries({ queryKey: ["skill-market", "list"] }),
      client.invalidateQueries({ queryKey: ["skill-market", "detail"] }),
    ]).then(() => undefined)
  const run = <A,>(key: SkillKey, operation: DesktopOperation, request: () => Promise<A>) => {
    setPending(skillKey(key), operation)
    return request()
      .then((result) => invalidate().then(() => result))
      .then(
        (result) => {
          setPending(skillKey(key), undefined)
          return result
        },
        (error) => {
          setPending(skillKey(key), undefined)
          return Promise.reject(error)
        },
      )
  }
  const request = (detail: SkillMarket.Detail, riskConfirmed: boolean): SkillMarket.InstallRequest => ({
    source: detail.source,
    id: detail.id,
    version: detail.version,
    sha256: detail.package.sha256,
    riskConfirmed: riskConfirmed || undefined,
  })

  return (
    <DesktopSkillMarketContext.Provider
      value={{
        installed: () => installed.data ?? [],
        item: (key) => byKey().get(skillKey(key)),
        pending: (key) => pending[skillKey(key)],
        install: (detail, riskConfirmed) => {
          if (!actions) return Promise.reject(new Error("Desktop market actions are missing"))
          return run(detail, "install", () => actions.install(request(detail, riskConfirmed)))
        },
        update: (detail, riskConfirmed) => {
          if (!actions) return Promise.reject(new Error("Desktop market actions are missing"))
          return run(detail, "update", () => actions.update(request(detail, riskConfirmed)))
        },
        uninstall: (key) => {
          if (!actions) return Promise.reject(new Error("Desktop market actions are missing"))
          return run(key, "uninstall", () => actions.uninstall(key))
        },
        refresh: (key) => {
          if (!actions) return Promise.reject(new Error("Desktop market actions are missing"))
          return run(key, "refresh", () => actions.refresh(key))
        },
        errorMessage: (error) => skillMarketErrorMessage(error, props.translate ?? ((key) => key)),
      }}
    >
      {props.children}
    </DesktopSkillMarketContext.Provider>
  )
}

export function useDesktopSkillMarket() {
  const context = useContext(DesktopSkillMarketContext)
  if (!context) throw new Error("DesktopSkillMarketProvider is missing")
  return context
}

function skillKey(key: SkillKey) {
  return `${key.source}:${key.id}`
}
