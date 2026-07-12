import { expect, test } from "bun:test"

test("the shared selected-server providers gate both visual layouts exactly once", async () => {
  const source = await Bun.file(new URL("app.tsx", import.meta.url)).text()
  const selected = source.slice(
    source.indexOf("function SelectedServerProviders"),
    source.indexOf("function LegacyServerLayout"),
  )
  const newLayout = source.slice(source.indexOf("function NewAppLayout"), source.indexOf("function DraftServerScopedProviders"))

  expect(selected).toContain("<RuyingGate>")
  expect(selected).toContain("<ServerSyncProvider>")
  expect(newLayout).not.toContain("<RuyingGate>")
  expect(source.match(/<RuyingGate>/g)).toHaveLength(1)
})
