import { expect, mock, test } from "bun:test"
import { render } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import type { ParentProps } from "solid-js"
import { isSkillMarketEnabled, skillMarketSubmissionUrl } from "@/skill-market/feature"

const submissionUrl = "https://market.example.com/ruying/skill-market/submissions/new"
const openLink = mock((_url: string) => undefined)
const navigate = mock((_target: string | number) => undefined)

mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ client: {} }) }))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ openLink }) }))
mock.module("@solidjs/router", () => ({ useNavigate: () => navigate, useParams: () => ({}) }))
mock.module("@/skill-market", () => ({
  createDesktopSkillMarket: () => ({ source: {}, actions: { kind: "desktop" } }),
  DesktopSkillMarketProvider: (props: ParentProps) => props.children,
  SkillMarketProvider: (props: ParentProps) => props.children,
  SkillMarketDetail: () => <div />,
  SkillMarketList: (props: { onSubmit?: () => void }) => (
    <button type="button" onClick={props.onSubmit}>
      投稿 Skill
    </button>
  ),
  skillMarketSubmissionUrl: () => submissionUrl,
}))

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

const { parseSkillKey, SkillMarketRoute } = await import("./skill-market")
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
  expect(parseSkillKey("community", "safe%2Fskill")).toEqual({ source: "community", id: "safe/skill" })
  expect(parseSkillKey("other", "code-review")).toBeUndefined()
  expect(parseSkillKey("skillhub", "%E0%A4%A")).toBeUndefined()
  expect(parseSkillKey(undefined, undefined)).toBeUndefined()
})

test("constructs only secure or explicitly allowed private submission URLs", () => {
  expect(skillMarketSubmissionUrl("https://market.example.com/ruying/skill-market/", false)).toBe(
    "https://market.example.com/ruying/skill-market/submissions/new",
  )
  expect(skillMarketSubmissionUrl("http://10.246.13.226/skill-market", true)).toBe(
    "http://10.246.13.226/skill-market/submissions/new",
  )
  expect(skillMarketSubmissionUrl("http://localhost:4173", false)).toBe("http://localhost:4173/submissions/new")
  expect(skillMarketSubmissionUrl("http://market.example.com", true)).toBeUndefined()
  expect(skillMarketSubmissionUrl("not a url", true)).toBeUndefined()
  expect(skillMarketSubmissionUrl(undefined, true)).toBeUndefined()
})

test("opens the validated Web submission URL from the desktop market", async () => {
  openLink.mockClear()
  const view = render(() => <SkillMarketRoute />)

  await userEvent.click(view.getByRole("button", { name: "投稿 Skill" }))

  expect(openLink).toHaveBeenCalledTimes(1)
  expect(openLink).toHaveBeenCalledWith(submissionUrl)
})
