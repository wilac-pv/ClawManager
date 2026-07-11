import { expect, test } from "bun:test"

const surfaces = [
  "src/app.tsx",
  "src/component/dialog-model.tsx",
  "src/component/prompt/index.tsx",
  "src/context/local.tsx",
  "src/feature-plugins/home/tips-view.tsx",
  "src/feature-plugins/sidebar/footer.tsx",
  "src/routes/session/footer.tsx",
  "src/routes/session/index.tsx",
  "src/routes/session/permission.tsx",
  "src/util/presentation.ts",
  "../opencode/src/cli/cmd/run/footer.permission.tsx",
  "../opencode/src/cli/cmd/run/permission.shared.ts",
]

test("public OEM surfaces contain no generic provider connection copy", async () => {
  const source = (await Promise.all(surfaces.map((file) => Bun.file(file).text()))).join("\n")

  expect(source).not.toMatch(/\/connect\b/)
  expect(source).not.toContain("Connect a provider")
  expect(source).not.toMatch(/75\+ providers/i)
  expect(source).not.toMatch(/opencode auth list/i)
  expect(source).not.toContain("OpenCode")
  expect(source).not.toContain("opencode -s")
  expect(source).not.toContain("█▀▀█")
})

test("Ruying OAuth browser copy contains no legacy product name", async () => {
  const source = await Bun.file("../opencode/src/plugin/ruying.ts").text()

  expect(source).not.toContain("<title>opencode")
  expect(source).not.toContain("返回 opencode")
  expect(source).not.toContain("opencode 会自动捕获回调")
})

test("OEM help and crash surfaces contain no public upstream exits", async () => {
  const files = [
    "src/app.tsx",
    "src/component/error-component.tsx",
    "../app/src/pages/layout.tsx",
    "../app/src/pages/home.tsx",
    "../app/src/pages/error.tsx",
    "../desktop/src/main/onboarding.ts",
  ]
  const source = (await Promise.all(files.map((file) => Bun.file(file).text()))).join("\n")

  expect(source).not.toContain("https://opencode.ai/docs")
  expect(source).not.toContain("https://opencode.ai/desktop-feedback")
  expect(source).not.toContain("github.com/anomalyco/opencode/issues")
  expect(source).not.toContain("New OpenCode Project")
})
