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
]

test("public OEM surfaces contain no generic provider connection copy", async () => {
  const source = (await Promise.all(surfaces.map((file) => Bun.file(file).text()))).join("\n")

  expect(source).not.toMatch(/\/connect\b/)
  expect(source).not.toContain("Connect a provider")
  expect(source).not.toMatch(/75\+ providers/i)
  expect(source).not.toMatch(/opencode auth list/i)
  expect(source).not.toContain("OpenCode")
})
