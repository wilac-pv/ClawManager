import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillMarketInstaller } from "@opencode-ai/core/skill/market-installer"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const fixture = path.join(import.meta.dir, "../fixtures/skill-market/valid.zip")

it.live("installs globally, writes ownership and reloads without restart", () =>
  environment().pipe(
    Effect.flatMap((env) =>
      Effect.gen(function* () {
        const result = yield* env.installer.install(env.detail, env.request)
        expect(result.changed).toBe(true)
        expect(
          yield* Effect.promise(() => Bun.file(path.join(env.config, "skills/code-review/SKILL.md")).exists()),
        ).toBe(true)
        expect(
          yield* Effect.promise(() =>
            Bun.file(path.join(env.config, "skills/code-review/.ruying-market.json")).exists(),
          ),
        ).toBe(true)
        expect((yield* env.skills.list()).map((skill) => skill.name)).toContain("code-review")
        expect((yield* env.installer.installed())[0]).toMatchObject({
          source: "skillhub",
          id: "code-review",
          version: "1.0.0",
          loadState: "ready",
        })

        const retry = yield* env.installer.install(env.detail, env.request)
        expect(retry.changed).toBe(false)
        expect(env.requests.length).toBe(1)
      }),
    ),
  ),
)

it.live("rejects missing risk confirmation, hash mismatch and unsafe ids before download", () =>
  environment().pipe(
    Effect.flatMap((env) =>
      Effect.gen(function* () {
        expect(
          yield* env.installer.install({ ...env.detail, risk: "warning" }, env.request).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
        ).toBe("risk-confirmation-required")
        expect(
          yield* env.installer.install(env.detail, { ...env.request, sha256: "b".repeat(64) }).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
        ).toBe("hash-mismatch")
        expect(
          yield* env.installer.install({ ...env.detail, id: "../escape" }, { ...env.request, id: "../escape" }).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
        ).toBe("invalid-skill")
        expect(env.requests).toHaveLength(0)

        expect(
          yield* env.installer.install({ ...env.detail, delisted: true }, env.request).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
        ).toBe("skill-delisted")
        expect(
          yield* env.installer
            .install({ ...env.detail, package: { ...env.detail.package, size: 51 * 1024 * 1024 } }, env.request)
            .pipe(
              Effect.flip,
              Effect.map((error) => error.code),
            ),
        ).toBe("archive-limit")

        const remoteHash = "a".repeat(64)
        expect(
          yield* env.installer
            .install(
              { ...env.detail, package: { ...env.detail.package, sha256: remoteHash } },
              { ...env.request, sha256: remoteHash },
            )
            .pipe(
              Effect.flip,
              Effect.map((error) => error.code),
            ),
        ).toBe("hash-mismatch")
        expect(
          yield* env.installer.install({ ...env.detail, id: "other" }, { ...env.request, id: "other" }).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
        ).toBe("invalid-skill")
        expect(env.requests).toHaveLength(2)
      }),
    ),
  ),
)

it.live("serializes concurrent operations for the same Skill ID", () =>
  environment().pipe(
    Effect.flatMap((env) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          [env.installer.install(env.detail, env.request), env.installer.install(env.detail, env.request)],
          { concurrency: "unbounded" },
        )
        expect(results.map((result) => result.changed).toSorted()).toEqual([false, true])
        expect(env.requests).toHaveLength(1)
      }),
    ),
  ),
)

it.live("restores the old version when atomic replacement fails", () => {
  const failure = { enabled: false, target: "" }
  return environment(failure).pipe(
    Effect.flatMap((env) =>
      Effect.gen(function* () {
        yield* env.installer.install(env.detail, env.request)
        const skill = path.join(env.config, "skills/code-review/SKILL.md")
        yield* Effect.promise(() => fs.appendFile(skill, "\nold-version"))
        failure.enabled = true

        expect(
          yield* env.installer.update({ ...env.detail, version: "2.0.0" }, { ...env.request, version: "2.0.0" }).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
        ).toBe("disk-unavailable")
        expect(yield* Effect.promise(() => Bun.file(skill).text())).toContain("old-version")
        expect((yield* env.installer.installed())[0]?.version).toBe("1.0.0")
      }),
    ),
  )
})

it.live("keeps manual skills untouched and supports offline inventory, refresh and uninstall", () =>
  environment().pipe(
    Effect.flatMap((env) =>
      Effect.gen(function* () {
        const manual = path.join(env.config, "skills/manual/SKILL.md")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(manual), { recursive: true })
          await fs.writeFile(manual, "---\nname: manual\n---\nmanual")
        })
        expect(
          yield* env.installer.uninstall({ source: "skillhub", id: "manual" }).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
        ).toBe("not-market-owned")
        expect(yield* Effect.promise(() => Bun.file(manual).exists())).toBe(true)

        yield* env.installer.install(env.detail, env.request)
        const requests = env.requests.length
        expect((yield* env.installer.installed()).map((skill) => skill.id)).toEqual(["code-review"])
        yield* env.installer.refresh({ source: "skillhub", id: "code-review" })
        yield* env.installer.uninstall({ source: "skillhub", id: "code-review" })
        expect(env.requests.length).toBe(requests)
        expect(yield* Effect.promise(() => Bun.file(path.join(env.config, "skills/code-review")).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(manual).exists())).toBe(true)
      }),
    ),
  ),
)

function environment(failure?: { enabled: boolean; target: string }) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) =>
      Effect.promise(async () => {
        const bytes = await Bun.file(fixture).bytes()
        return {
          config: tmp.path,
          bytes,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        }
      }),
    ),
    Effect.flatMap((input) => {
      const requests: string[] = []
      const client = HttpClient.make((request) => {
        requests.push(request.url)
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(input.bytes, { headers: { "content-length": String(input.bytes.byteLength) } }),
          ),
        )
      })
      if (failure) failure.target = path.join(input.config, "skills/code-review")
      return Effect.gen(function* () {
        const installer = yield* SkillMarketInstaller.Service
        const skills = yield* SkillV2.Service
        yield* skills.transform((draft) =>
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.join(input.config, "skills")),
            }),
          ),
        )
        const detail = sampleDetail(input.sha256, input.bytes.byteLength)
        return { ...input, installer, skills, detail, request: sampleRequest(input.sha256), requests }
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([SkillMarketInstaller.node, SkillV2.node]), [
            [Global.node, Global.layerWith({ config: input.config })],
            [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
            ...(failure ? ([[FSUtil.node, failingFileSystem(failure)]] as const) : []),
          ]),
        ),
      )
    }),
  )
}

function failingFileSystem(failure: { enabled: boolean; target: string }) {
  return Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        rename: (oldPath, newPath) =>
          failure.enabled && newPath === failure.target && oldPath.includes(`${path.sep}extracted`)
            ? fs.rename(`${oldPath}.missing`, newPath)
            : fs.rename(oldPath, newPath),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(FSUtil.node)))
}

function sampleDetail(sha256: string, size: number): SkillMarket.Detail {
  return {
    id: "code-review",
    source: "skillhub",
    sourceUrl: "https://skillhub.example.com/skills/code-review",
    name: "Code Review",
    description: "Review code",
    categories: ["代码质量"],
    tags: ["review"],
    requiresApiKey: false,
    risk: "safe",
    version: "1.0.0",
    updatedAt: "2026-07-15T01:00:00.000Z",
    downloads: 1,
    favorites: 0,
    score: 100,
    featured: true,
    enterprise: false,
    delisted: false,
    readme: "# Code Review",
    author: { name: "Ruying" },
    versions: [{ version: "1.0.0", publishedAt: "2026-07-15T01:00:00.000Z", sha256, size }],
    securityReports: [],
    package: { url: "https://downloads.example.com/code-review.zip", sha256, size, files: [] },
    publicDetailUrl: "https://market.example.com/skills/skillhub/code-review",
  }
}

function sampleRequest(sha256: string): SkillMarket.InstallRequest {
  return { source: "skillhub", id: "code-review", version: "1.0.0", sha256 }
}
