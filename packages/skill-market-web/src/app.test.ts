import { expect, test } from "bun:test"

test("registers the SkillHub import admin route", async () => {
  const source = await Bun.file(new URL("./app.tsx", import.meta.url)).text()

  expect(source).toContain('import { SkillHubImport } from "./admin/skillhub"')
  expect(source).toContain(
    '<Route path="/admin/skillhub" component={() => <SkillHubImportRoute source={control} />} />',
  )
})
