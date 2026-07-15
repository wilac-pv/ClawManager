import { SkillMarketInstaller } from "@opencode-ai/core/skill/market-installer"
import { normalizeSkillMarketCatalogQuery } from "@opencode-ai/protocol/groups/skill-market-catalog"
import {
  SkillMarketConflictError,
  SkillMarketOperationError,
  SkillMarketUnavailableError,
  type SkillMarketLocalError,
} from "@opencode-ai/protocol/groups/skill-market-local"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SkillMarketCatalog } from "../skill-market/catalog"

export const SkillMarketHandler = HttpApiBuilder.group(Api, "server.skillMarket", (handlers) =>
  handlers
    .handle("skillMarket.list", (ctx) =>
      Effect.gen(function* () {
        const catalog = yield* SkillMarketCatalog.Service
        const installer = yield* SkillMarketInstaller.Service
        const [page, installed] = yield* Effect.all([
          catalog.list(normalizeSkillMarketCatalogQuery(ctx.query)),
          installer.installed(),
        ])
        const versions = new Map(installed.map((skill) => [`${skill.source}/${skill.id}`, skill.version]))
        return {
          ...page,
          items: page.items.map((skill) => {
            const installedVersion = versions.get(`${skill.source}/${skill.id}`)
            return {
              ...skill,
              installedVersion,
              updateAvailable: installedVersion === undefined ? undefined : installedVersion !== skill.version,
            }
          }),
        }
      }).pipe(Effect.mapError(toLocalError)),
    )
    .handle("skillMarket.facets", () =>
      SkillMarketCatalog.Service.use((catalog) => catalog.facets()).pipe(Effect.mapError(toLocalError)),
    )
    .handle("skillMarket.detail", (ctx) =>
      SkillMarketCatalog.Service.use((catalog) => catalog.detail(ctx.params)).pipe(Effect.mapError(toLocalError)),
    )
    .handle("skillMarket.installed", () =>
      SkillMarketInstaller.Service.use((installer) => installer.installed()).pipe(Effect.mapError(toLocalError)),
    )
    .handle("skillMarket.updates", () =>
      Effect.gen(function* () {
        const catalog = yield* SkillMarketCatalog.Service
        const installer = yield* SkillMarketInstaller.Service
        const installed = yield* installer.installed()
        const updates = yield* Effect.forEach(
          installed,
          (skill) =>
            catalog
              .detail({ source: skill.source, id: skill.id })
              .pipe(Effect.map((detail) => ({ ...skill, updateAvailable: detail.version !== skill.version }))),
          { concurrency: 4 },
        )
        return updates.filter((skill) => skill.updateAvailable)
      }).pipe(Effect.mapError(toLocalError)),
    )
    .handle("skillMarket.install", (ctx) => mutate("install", ctx.payload).pipe(Effect.mapError(toLocalError)))
    .handle("skillMarket.update", (ctx) => mutate("update", ctx.payload).pipe(Effect.mapError(toLocalError)))
    .handle("skillMarket.uninstall", (ctx) =>
      SkillMarketInstaller.Service.use((installer) => installer.uninstall(ctx.params)).pipe(
        Effect.as(HttpApiSchema.NoContent.make()),
        Effect.mapError(toLocalError),
      ),
    )
    .handle("skillMarket.refresh", (ctx) =>
      SkillMarketInstaller.Service.use((installer) => installer.refresh(ctx.params)).pipe(
        Effect.as(HttpApiSchema.NoContent.make()),
        Effect.mapError(toLocalError),
      ),
    ),
)

function mutate(mode: "install" | "update", request: Parameters<SkillMarketInstaller.Interface["install"]>[1]) {
  return Effect.gen(function* () {
    const catalog = yield* SkillMarketCatalog.Service
    const installer = yield* SkillMarketInstaller.Service
    const detail = yield* catalog.revalidate({ source: request.source, id: request.id })
    if (detail.delisted) {
      return yield* new SkillMarketConflictError({
        name: "SkillMarketConflictError",
        code: "skill-delisted",
        message: "Skill 已下架",
      })
    }
    if (detail.version !== request.version) {
      return yield* new SkillMarketConflictError({
        name: "SkillMarketConflictError",
        code: "version-conflict",
        message: "目录版本已变化，请刷新后重试",
      })
    }
    if (detail.package.sha256 !== request.sha256) {
      return yield* new SkillMarketConflictError({
        name: "SkillMarketConflictError",
        code: "hash-mismatch",
        message: "目录摘要已变化，请刷新后重试",
      })
    }
    return yield* mode === "install" ? installer.install(detail, request) : installer.update(detail, request)
  })
}

function toLocalError(
  error: SkillMarketCatalog.CatalogError | SkillMarketInstaller.InstallerError | SkillMarketLocalError,
): SkillMarketLocalError {
  if (
    error instanceof SkillMarketUnavailableError ||
    error instanceof SkillMarketConflictError ||
    error instanceof SkillMarketOperationError
  ) {
    return error
  }
  if (error.code === "network-unavailable" || error.code === "market-unavailable") {
    return new SkillMarketUnavailableError({
      name: "SkillMarketUnavailableError",
      code: error.code,
      message: error.message,
    })
  }
  if (
    error.code === "skill-delisted" ||
    error.code === "risk-confirmation-required" ||
    error.code === "hash-mismatch" ||
    error.code === "version-conflict" ||
    error.code === "not-market-owned"
  ) {
    return new SkillMarketConflictError({ name: "SkillMarketConflictError", code: error.code, message: error.message })
  }
  return new SkillMarketOperationError({ name: "SkillMarketOperationError", code: error.code, message: error.message })
}
