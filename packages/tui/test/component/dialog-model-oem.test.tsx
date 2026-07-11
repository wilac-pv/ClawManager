/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"

const local = {
  model: {
    favorite: () => [
      { providerID: "ruying", modelID: "glm" },
      { providerID: "secondary", modelID: "favorite-leak" },
    ],
    recent: () => [
      { providerID: "secondary", modelID: "recent-leak" },
      { providerID: "ruying", modelID: "deepseek" },
    ],
    current: () => ({ providerID: "ruying", modelID: "glm" }),
    set: () => undefined,
    toggleFavorite: () => undefined,
    variant: { list: () => [], selected: () => undefined },
  },
}

const sync = {
  data: {
    provider: [
      {
        id: "ruying",
        name: "如影编码网关",
        models: {
          glm: model("glm", "GLM Secure", "ruying"),
          deepseek: model("deepseek", "DeepSeek Secure", "ruying"),
        },
      },
      {
        id: "secondary",
        name: "Secondary Connect Provider",
        models: {
          "favorite-leak": model("favorite-leak", "Favorite Leak", "secondary"),
          "recent-leak": model("recent-leak", "Recent Leak", "secondary"),
        },
      },
    ],
  },
}

mock.module("../../src/context/local", () => ({ useLocal: () => local }))
mock.module("../../src/context/sync", () => ({ useSync: () => sync }))
mock.module("../../src/component/use-connected", () => ({ useConnected: () => () => true }))

const [
  { DialogModel },
  { DialogProvider, useDialog },
  { KVProvider },
  { ThemeProvider },
  { TuiConfigProvider },
  { ToastProvider },
  keymap,
] = await Promise.all([
  import("../../src/component/dialog-model"),
  import("../../src/ui/dialog"),
  import("../../src/context/kv"),
  import("../../src/context/theme"),
  import("../../src/config"),
  import("../../src/ui/toast"),
  import("../../src/keymap"),
])

function model(id: string, name: string, providerID: string) {
  return {
    id,
    name,
    providerID,
    status: "active",
    release_date: "2026-01-01",
    cost: { input: 1, output: 1 },
  }
}

test("mounted DialogModel hides secondary providers, favorites, recents, and connect paths", async () => {
  await using root = await tmpdir()
  const state = path.join(root.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  function Harness() {
    const renderer = useRenderer()
    const bindings = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(keymap.registerOpencodeKeymap(bindings, renderer, config))
    return (
      <TestTuiContexts directory={root.path} paths={{ state }}>
        <keymap.OpencodeKeymapProvider keymap={bindings}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <OpenModelDialog />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </keymap.OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  function OpenModelDialog() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogModel />))
    return null
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 24, kittyKeyboard: true })
  try {
    await Bun.sleep(20)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("GLM Secure")
    expect(frame).toContain("DeepSeek Secure")
    expect(frame).not.toContain("Favorite Leak")
    expect(frame).not.toContain("Recent Leak")
    expect(frame).not.toContain("Secondary Connect Provider")
    expect(frame).not.toContain("Connect")
  } finally {
    app.renderer.destroy()
  }
})
