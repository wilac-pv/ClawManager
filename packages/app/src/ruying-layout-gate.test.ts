import { expect, test } from "bun:test"

test("the shared selected-server providers gate both visual layouts exactly once", async () => {
  const source = await Bun.file(new URL("app.tsx", import.meta.url)).text()
  const selected = source.slice(
    source.indexOf("function SelectedServerProviders"),
    source.indexOf("function LegacyServerLayout"),
  )
  const newLayout = source.slice(source.indexOf("function NewAppLayout"), source.indexOf("function DraftServerScopedProviders"))
  const legacyLayout = source.slice(source.indexOf("function LegacyServerLayout"), source.indexOf("function DraftRoute"))
  const runtimeLayout = source.slice(source.indexOf("function RuntimeServerLayout"), source.indexOf("function DraftRoute"))
  const routes = source.slice(source.indexOf("function Routes"), source.indexOf("function NewLayoutLegacySessionRedirect"))

  expect(selected).toContain("<RuyingGate>")
  expect(selected).toContain("<ServerSyncProvider>")
  expect(newLayout).not.toContain("<RuyingGate>")
  expect(newLayout.match(/<SelectedServerProviders>/g)).toHaveLength(1)
  expect(legacyLayout.match(/<SelectedServerProviders>/g)).toHaveLength(1)
  expect(runtimeLayout).toContain("newLayoutDesigns")
  expect(runtimeLayout).toContain("fallback={<LegacyServerLayout")
  expect(routes).toContain("<RuntimeServerLayout")
  expect(routes).not.toContain("<LegacyServerLayout")
  expect(source.match(/<RuyingGate>/g)).toHaveLength(1)
})
