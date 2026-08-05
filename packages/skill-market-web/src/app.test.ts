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

test("defines shared typography tokens and form control inheritance", async () => {
  const styles = await Bun.file(new URL("./styles.css", import.meta.url)).text()

  expect(styles).toContain('--font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;')
  expect(styles).toContain('--font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;')
  expect(styles).toMatch(/button,\s*input,\s*select,\s*textarea[\s\S]*font: inherit/)
})
