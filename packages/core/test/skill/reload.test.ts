import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Context, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LocationServiceMap.node))

it.live("reload in one Location invalidates Skill caches in every active Location", () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const skills = path.join(tmp.path, "skills")
        const file = path.join(skills, "review", "SKILL.md")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.mkdir(path.join(tmp.path, "first"))
          await fs.mkdir(path.join(tmp.path, "second"))
          await fs.writeFile(file, "---\nname: review\ndescription: old\n---\nold")
        })

        const locations = yield* LocationServiceMap.Service
        const first = Context.get(
          yield* locations.contextEffect(
            Location.Ref.make({ directory: AbsolutePath.make(path.join(tmp.path, "first")) }),
          ),
          SkillV2.Service,
        )
        const second = Context.get(
          yield* locations.contextEffect(
            Location.Ref.make({ directory: AbsolutePath.make(path.join(tmp.path, "second")) }),
          ),
          SkillV2.Service,
        )
        const source = SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(skills) })
        yield* first.transform((draft) => draft.source(source))
        yield* second.transform((draft) => draft.source(source))

        expect((yield* first.list()).find((skill) => skill.name === "review")?.content).toBe("old")
        expect((yield* second.list()).find((skill) => skill.name === "review")?.content).toBe("old")
        yield* Effect.promise(() => fs.writeFile(file, "---\nname: review\ndescription: new\n---\nnew"))
        yield* first.reload()

        expect((yield* first.list()).find((skill) => skill.name === "review")?.content).toBe("new")
        expect((yield* second.list()).find((skill) => skill.name === "review")?.content).toBe("new")
      }),
    ),
  ),
)
