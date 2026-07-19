import { describe, expect, test } from "bun:test"
import { resolveSkillMarketRuntime } from "./runtime-config"

describe("Skill market runtime configuration", () => {
  test("defaults production requests to the page origin", () => {
    expect(resolveSkillMarketRuntime(undefined, "http://10.246.13.226:4211", undefined)).toEqual({
      apiBaseUrl: "http://10.246.13.226:4211",
      allowInsecurePrivateHttp: true,
    })
  })

  test("keeps explicit development API overrides opt-in for private HTTP", () => {
    expect(
      resolveSkillMarketRuntime(" http://10.246.13.226:4210 ", "http://10.246.13.226:4211", undefined),
    ).toEqual({
      apiBaseUrl: "http://10.246.13.226:4210",
      allowInsecurePrivateHttp: false,
    })
    expect(
      resolveSkillMarketRuntime("http://10.246.13.226:4210", "http://10.246.13.226:4211", "true"),
    ).toEqual({
      apiBaseUrl: "http://10.246.13.226:4210",
      allowInsecurePrivateHttp: true,
    })
  })
})
