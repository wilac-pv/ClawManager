import { createContext, useContext, type ParentProps } from "solid-js"
import type { SkillMarketActions, SkillMarketDataSource } from "./types"

const SkillMarketContext = createContext<{
  source: SkillMarketDataSource
  actions: SkillMarketActions
}>()

export function SkillMarketProvider(
  props: ParentProps<{
    source: SkillMarketDataSource
    actions: SkillMarketActions
  }>,
) {
  return (
    <SkillMarketContext.Provider value={{ source: props.source, actions: props.actions }}>
      {props.children}
    </SkillMarketContext.Provider>
  )
}

export function useSkillMarket() {
  const context = useContext(SkillMarketContext)
  if (!context) throw new Error("SkillMarketProvider is missing")
  return context
}
