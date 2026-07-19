import { describe, expect, test } from "bun:test"
import { resolveSkillMarketRuntime, skillDetailUrl, skillPackageUrl } from "./runtime-config"

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

  test("builds encoded package URLs from the runtime API origin", () => {
    expect(
      skillPackageUrl("http://10.246.13.226:4211", {
        source: "skillhub",
        id: "PPT 优化/助手",
      }),
    ).toBe("http://10.246.13.226:4211/v1/catalog/skills/skillhub/PPT%20%E4%BC%98%E5%8C%96%2F%E5%8A%A9%E6%89%8B/package")
    expect(
      skillPackageUrl("http://10.246.13.226:4210", {
        source: "community",
        id: "safe-community-skill",
      }),
    ).toBe("http://10.246.13.226:4210/v1/catalog/skills/community/safe-community-skill/package")
  })

  test("builds encoded detail URLs below the configured Web base path", () => {
    expect(
      skillDetailUrl("http://10.246.13.226:4211", "/skill-market/", {
        source: "skillhub",
        id: "PPT 优化/助手",
      }),
    ).toBe("http://10.246.13.226:4211/skill-market/skills/skillhub/PPT%20%E4%BC%98%E5%8C%96%2F%E5%8A%A9%E6%89%8B")
  })
})
