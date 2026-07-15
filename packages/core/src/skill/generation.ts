export * as SkillGeneration from "./generation"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export interface Interface {
  readonly current: () => number
  readonly bump: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillGeneration") {}

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const state = { value: 0 }
    return Service.of({
      current: () => state.value,
      bump: Effect.fn("SkillGeneration.bump")(function* () {
        state.value += 1
        return state.value
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
