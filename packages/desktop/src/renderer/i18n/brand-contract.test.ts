import { expect, test } from "bun:test"

test("every dormant Desktop renderer dictionary uses visible Ruying Code identity", async () => {
  const directory = new URL("./", import.meta.url)
  const dictionaries = [...new Bun.Glob("*.ts").scanSync({ cwd: directory.pathname })].filter(
    (name) => name !== "index.ts" && !name.endsWith(".test.ts"),
  )
  expect(dictionaries.length).toBeGreaterThan(0)

  for (const dictionary of dictionaries) {
    const source = await Bun.file(new URL(dictionary, directory)).text()
    expect(source, dictionary).not.toContain("OpenCode")
    expect(source, dictionary).not.toContain("opencode")
  }
})
