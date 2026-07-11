import { expect, test } from "bun:test"
import { join } from "node:path"

const root = join(import.meta.dir, "../../..")

test("uses only branded desktop artifact names in release scripts and workflows", async () => {
  const paths = [
    ...(await Array.fromAsync(new Bun.Glob("packages/desktop/scripts/*.ts").scan({ cwd: root }))).filter(
      (path) => !path.endsWith(".test.ts"),
    ),
    ...(await Array.fromAsync(new Bun.Glob(".github/workflows/*.{yml,yaml}").scan({ cwd: root, dot: true }))),
  ]
  const legacy = (
    await Promise.all(paths.map(async (path) => ({ path, content: await Bun.file(join(root, path)).text() })))
  ).filter((file) => file.content.includes("opencode-desktop"))

  expect(legacy).toEqual([])

  const workflow = await Bun.file(join(root, ".github/workflows/publish.yml")).text()
  const finalizer = await Bun.file(join(root, "packages/desktop/scripts/finalize-latest-json.ts")).text()
  expect(workflow).toContain('OUT_NAME="ruying-code-desktop-mac-x64.app.tar.gz"')
  expect(workflow).toContain('OUT_NAME="ruying-code-desktop-mac-arm64.app.tar.gz"')
  expect(workflow).toContain("name: ruying-code-desktop-${{ matrix.settings.target }}")
  expect(workflow).toContain("pattern: ruying-code-desktop-*")
  expect(finalizer).toContain('const macxTarGz = "ruying-code-desktop-mac-x64.app.tar.gz"')
  expect(finalizer).toContain('const macaTarGz = "ruying-code-desktop-mac-arm64.app.tar.gz"')
})
