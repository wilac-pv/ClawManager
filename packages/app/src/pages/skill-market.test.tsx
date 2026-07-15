import { expect, mock, test } from "bun:test"
import { render } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import type { ParentProps } from "solid-js"
import { isSkillMarketEnabled } from "@/skill-market/feature"
import { parseSkillKey } from "./skill-market"

mock.module("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: ParentProps) => props.children,
  TooltipKeybind: (props: ParentProps) => props.children,
}))
mock.module("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: { "aria-label"?: string; onClick?: () => void; icon: string }) => (
    <button type="button" aria-label={props["aria-label"]} onClick={props.onClick}>
      {props.icon}
    </button>
  ),
}))

const { SidebarContent } = await import("./layout/sidebar-shell")

test("places Skills immediately before Settings and opens the market", async () => {
  const calls: string[] = []
  const view = render(() => (
    <SidebarContent
      opened={() => true}
      aimMove={() => undefined}
      projects={() => []}
      renderProject={() => <div />}
      handleDragStart={() => undefined}
      handleDragEnd={() => undefined}
      handleDragOver={() => undefined}
      openProjectLabel="Open project"
      openProjectKeybind={() => undefined}
      onOpenProject={() => undefined}
      renderProjectOverlay={() => <div />}
      skillsLabel={() => "Skills"}
      onOpenSkills={() => calls.push("skills")}
      settingsLabel={() => "设置"}
      settingsKeybind={() => undefined}
      onOpenSettings={() => calls.push("settings")}
      helpLabel={() => "帮助"}
      renderPanel={() => <div />}
    />
  ))
  const buttons = view.getAllByRole("button")
  const skills = buttons.findIndex((button) => button.getAttribute("aria-label") === "Skills")
  const settings = buttons.findIndex((button) => button.getAttribute("aria-label") === "设置")

  expect(skills).toBe(settings - 1)
  await userEvent.click(view.getByRole("button", { name: "Skills" }))
  expect(calls).toEqual(["skills"])
})

test("omits the sidebar entry when the market is disabled", () => {
  const view = render(() => (
    <SidebarContent
      opened={() => true}
      aimMove={() => undefined}
      projects={() => []}
      renderProject={() => <div />}
      handleDragStart={() => undefined}
      handleDragEnd={() => undefined}
      handleDragOver={() => undefined}
      openProjectLabel="Open project"
      openProjectKeybind={() => undefined}
      onOpenProject={() => undefined}
      renderProjectOverlay={() => <div />}
      settingsLabel={() => "设置"}
      settingsKeybind={() => undefined}
      onOpenSettings={() => undefined}
      helpLabel={() => "帮助"}
      renderPanel={() => <div />}
    />
  ))

  expect(view.queryByRole("button", { name: "Skills" })).toBeNull()
  expect(isSkillMarketEnabled("false")).toBe(false)
  expect(isSkillMarketEnabled(undefined)).toBe(true)
})

test("parses only supported shareable detail routes", () => {
  expect(parseSkillKey("skillhub", "code%2Freview")).toEqual({ source: "skillhub", id: "code/review" })
  expect(parseSkillKey("other", "code-review")).toBeUndefined()
  expect(parseSkillKey("skillhub", "%E0%A4%A")).toBeUndefined()
  expect(parseSkillKey(undefined, undefined)).toBeUndefined()
})
