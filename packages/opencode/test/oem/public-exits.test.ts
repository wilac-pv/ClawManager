import { describe, expect, test } from "bun:test"

describe("OEM public exits", () => {
  test("ACP advertises the branded executable login flow", async () => {
    const source = await Bun.file(new URL("../../src/acp/service.ts", import.meta.url)).text()
    expect(source).toContain("Brand.profile.cliName")
    expect(source).toContain('args: ["login"]')
    expect(source).not.toContain("opencode auth login")
    expect(source).not.toContain('name: "OpenCode"')
  })

  test("retry status contains no public subscription or workspace link", async () => {
    const source = await Bun.file(new URL("../../src/session/retry.ts", import.meta.url)).text()
    expect(source).not.toContain("opencode.ai")
    expect(source).not.toContain("Subscribe to OpenCode")
    expect(source).not.toContain("GO_UPSELL")
  })

  test("runtime config and compatibility console handlers do not reach upstream services", async () => {
    const config = await Bun.file(new URL("../../src/config/config.ts", import.meta.url)).text()
    expect(config).not.toContain("https://opencode.ai/config.json")
    expect(config).not.toContain("Account.Service")

    const handlers = await Bun.file(
      new URL("../../src/server/routes/instance/httpapi/handlers/experimental.ts", import.meta.url),
    ).text()
    expect(handlers).not.toContain("Account.Service")
    expect(handlers).toContain("return { orgs: [] }")
    expect(handlers).toContain("return false")
  })

  test("built-in customization guidance is OEM-only", async () => {
    const skill = await Bun.file(new URL("../../../core/src/plugin/skill/customize-opencode.md", import.meta.url)).text()
    expect(skill).toContain("Ruying Code")
    expect(skill).toContain("ruying-code.json")
    expect(skill).not.toContain("opencode.ai")
    expect(skill).not.toContain("customize-opencode")
  })
})
