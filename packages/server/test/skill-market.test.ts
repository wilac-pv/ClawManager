import path from "node:path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Global } from "@opencode-ai/core/global"
import { SkillMarketCatalog } from "@opencode-ai/server/skill-market/catalog"
import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"

const it = testEffect(Layer.empty)

it.live("decodes remote catalog data and uses the last successful cache while offline", () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) => {
      const state = { available: true, redirect: false }
      const client = HttpClient.make((request) => {
        if (!state.available) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ error: "offline" }, { status: 503 })),
          )
        }
        if (state.redirect) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 302, headers: { location: "https://untrusted.example.com/catalog" } }),
            ),
          )
        }
        return Effect.succeed(HttpClientResponse.fromWeb(request, response(new URL(request.url))))
      })
      return Effect.gen(function* () {
        const catalog = yield* SkillMarketCatalog.Service
        const query = { sort: "score", page: 1, limit: 30 } as const
        expect((yield* catalog.list(query)).items[0]?.id).toBe("code-review")
        expect((yield* catalog.detail({ source: "skillhub", id: "code-review" })).version).toBe("1.2.0")
        state.available = false
        const sourceStatus = (yield* catalog.list(query)).sourceStatus
        expect(sourceStatus.skillhub).toBe("stale")
        expect(sourceStatus.community).toBe("stale")
        expect((yield* catalog.detail({ source: "skillhub", id: "code-review" })).id).toBe("code-review")
        expect(
          yield* catalog.revalidate({ source: "skillhub", id: "code-review" }).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
        ).toBe("network-unavailable")
        state.available = true
        state.redirect = true
        expect(
          yield* catalog.list({ ...query, query: "redirect" }).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          ),
        ).toBe("market-unavailable")
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "skill-market/catalog.json")).exists())).toBe(
          true,
        )
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            SkillMarketCatalog.makeNode({
              baseUrl: "http://10.246.13.226:4210",
              allowedHosts: new Set(["10.246.13.226", "downloads.example.com"]),
              allowInsecurePrivateHttp: true,
            }),
            [
              [Global.node, Global.layerWith({ cache: tmp.path })],
              [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
            ],
          ),
        ),
      )
    }),
  ),
)

function response(url: URL) {
  if (url.pathname === "/v1/catalog/skills") return Response.json(page)
  if (url.pathname === "/v1/catalog/facets") {
    return Response.json({
      revision: "r1",
      sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
      sources: [{ value: "skillhub", count: 1 }],
      categories: [{ value: "代码质量", count: 1 }],
      requiresApiKey: { yes: 0, no: 1 },
    })
  }
  if (url.pathname === "/v1/catalog/skills/skillhub/code-review") return Response.json(detail)
  return Response.json({ error: "not found" }, { status: 404 })
}

const summary = {
  id: "code-review",
  source: "skillhub",
  sourceUrl: "https://market.example.com/source/code-review",
  name: "Code Review",
  description: "Review code",
  categories: ["代码质量"],
  tags: ["review"],
  requiresApiKey: false,
  risk: "safe",
  version: "1.2.0",
  updatedAt: "2026-07-15T01:00:00.000Z",
  downloads: 10,
  favorites: 1,
  score: 98,
  featured: true,
  enterprise: false,
  delisted: false,
} satisfies SkillMarket.Summary

const page = {
  revision: "r1",
  sourceStatus: { skillhub: "fresh", enterprise: "fresh", community: "fresh" },
  total: 1,
  page: 1,
  limit: 30,
  items: [summary],
} satisfies SkillMarket.Page

const detail = {
  ...summary,
  readme: "# Code Review",
  author: { name: "Ruying" },
  versions: [],
  securityReports: [],
  package: { url: "https://downloads.example.com/code-review.zip", sha256: "a".repeat(64), size: 1, files: [] },
  publicDetailUrl: "https://market.example.com/skills/skillhub/code-review",
} satisfies SkillMarket.Detail
