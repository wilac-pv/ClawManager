/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-opencode.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-ruying-code",
            description:
              "Use ONLY when editing Ruying Code configuration, agents, commands, skills, plugins, MCP servers, or permission rules.",
            location: AbsolutePath.make("/builtin/customize-ruying-code.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
    })
  }),
})
