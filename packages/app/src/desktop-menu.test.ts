import { describe, expect, test } from "bun:test"
import { createDesktopMenu, DESKTOP_MENU } from "./desktop-menu"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.label === "Export Logs...",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("omits public exits without branded URLs and uses only internal URLs when configured", () => {
    const hidden = createDesktopMenu({})
    const hiddenHelp = hidden.find((menu) => menu.id === "help")?.items ?? []
    expect(hiddenHelp.filter((item) => item.type === "item" && item.href)).toEqual([])

    const visible = createDesktopMenu({
      docs: "https://internal.example/docs",
      support: "https://internal.example/support",
    })
    const visibleHelp = visible.find((menu) => menu.id === "help")?.items ?? []
    expect(visibleHelp.flatMap((item) => (item.type === "item" && item.href ? [item.href] : []))).toEqual([
      "https://internal.example/docs",
      "https://internal.example/support",
    ])
  })
})
