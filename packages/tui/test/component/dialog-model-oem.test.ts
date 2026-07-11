import { expect, test } from "bun:test"
import { visibleModelProviders } from "../../src/component/dialog-model"

test("model dialog behavior keeps only Ruying models from realistic provider state", () => {
  const providers = [
    { id: "ruying", name: "如影编码网关", models: { glm: { id: "glm" } } },
    { id: "test", name: "Configured second provider", models: { leaked: { id: "leaked" } } },
  ]

  expect(visibleModelProviders(providers).map((provider) => provider.id)).toEqual(["ruying"])
  expect(Object.keys(visibleModelProviders(providers)[0]!.models)).toEqual(["glm"])
})
