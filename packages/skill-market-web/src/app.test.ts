import { expect, test } from "bun:test"

test("registers the SkillHub import and announcement admin routes", async () => {
  const source = await Bun.file(new URL("./app.tsx", import.meta.url)).text()

  expect(source).toContain('import { SkillHubImport } from "./admin/skillhub"')
  expect(source).toContain(
    '<Route path="/admin/skillhub" component={() => <SkillHubImportRoute source={control} />} />',
  )
  expect(source).toContain(
    '<Route path="/admin/announcements" component={() => <AnnouncementAdministrationRoute source={control} />} />',
  )
})
