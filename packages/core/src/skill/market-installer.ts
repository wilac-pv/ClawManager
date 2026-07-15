export * as SkillMarketInstaller from "./market-installer"

import path from "node:path"
import { Cause, Context, Effect, Layer, Schema, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { ConfigMarkdown } from "../config/markdown"
import { KeyedMutex } from "../effect/keyed-mutex"
import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { SkillV2 } from "../skill"
import { ArchiveLimitError, extractZip, UnsafeArchiveError } from "./zip"

const maxArchiveBytes = 50 * 1024 * 1024
const limits = {
  archiveBytes: maxArchiveBytes,
  extractedBytes: 200 * 1024 * 1024,
  files: 2_000,
  ratio: 100,
}
const manifestName = ".ruying-market.json"
const operations = Semaphore.makeUnsafe(4)
const locks = KeyedMutex.makeUnsafe<string>()

const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  source: SkillMarket.Source,
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  sha256: SkillMarket.Sha256,
  installedAt: SkillMarket.Timestamp,
  sourceUrl: SkillMarket.HttpsUrl,
  loadState: Schema.Literals(["ready", "refresh-failed"]),
})
type Manifest = typeof Manifest.Type

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Manifest))
const decodeFrontmatter = Schema.decodeUnknownOption(Schema.Struct({ name: Schema.String }))

export const ErrorCode = Schema.Literals([
  "network-unavailable",
  "skill-delisted",
  "risk-confirmation-required",
  "hash-mismatch",
  "unsafe-archive",
  "archive-limit",
  "invalid-skill",
  "disk-unavailable",
  "version-conflict",
  "not-market-owned",
  "refresh-failed",
])
export type ErrorCode = typeof ErrorCode.Type

export class InstallerError extends Schema.TaggedErrorClass<InstallerError>()("SkillMarketInstallerError", {
  code: ErrorCode,
  message: Schema.String,
}) {}

export interface Interface {
  readonly install: (
    detail: SkillMarket.Detail,
    request: SkillMarket.InstallRequest,
  ) => Effect.Effect<SkillMarket.OperationResult, InstallerError>
  readonly update: (
    detail: SkillMarket.Detail,
    request: SkillMarket.InstallRequest,
  ) => Effect.Effect<SkillMarket.OperationResult, InstallerError>
  readonly uninstall: (key: { source: SkillMarket.Source; id: string }) => Effect.Effect<void, InstallerError>
  readonly installed: () => Effect.Effect<SkillMarket.Installed[], InstallerError>
  readonly refresh: (key: { source: SkillMarket.Source; id: string }) => Effect.Effect<void, InstallerError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillMarketInstaller") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const skill = yield* SkillV2.Service
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    const root = path.join(global.config, "skills")

    const exists = (target: string) =>
      fs
        .exists(target)
        .pipe(
          Effect.mapError(() => new InstallerError({ code: "disk-unavailable", message: "无法访问 Skill 文件系统" })),
        )

    const readManifest = Effect.fn("SkillMarketInstaller.readManifest")(function* (target: string) {
      const content = yield* fs
        .readFileStringSafe(path.join(target, manifestName))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!content) return
      return decodeManifest(content).valueOrUndefined
    })

    const writeManifest = Effect.fn("SkillMarketInstaller.writeManifest")(function* (
      target: string,
      manifest: Manifest,
    ) {
      yield* fs
        .writeFileString(path.join(target, manifestName), encodeManifest(manifest))
        .pipe(
          Effect.mapError(() => new InstallerError({ code: "disk-unavailable", message: "无法写入 Skill 安装清单" })),
        )
    })

    const download = Effect.fn("SkillMarketInstaller.download")(function* (url: string, destination: string) {
      const response = yield* HttpClientRequest.get(url).pipe(
        http.execute,
        Effect.mapError(() => new InstallerError({ code: "network-unavailable", message: "Skill 安装包下载失败" })),
      )
      const declared = response.headers["content-length"]
      const declaredSize = declared ? Number.parseInt(declared, 10) : undefined
      if (declaredSize !== undefined && Number.isSafeInteger(declaredSize) && declaredSize > maxArchiveBytes) {
        return yield* new InstallerError({ code: "archive-limit", message: "Skill 安装包超过 50 MiB" })
      }
      const hasher = new Bun.CryptoHasher("sha256")
      let size = 0
      yield* Effect.acquireUseRelease(
        Effect.sync(() => Bun.file(destination).writer({ highWaterMark: 1024 * 1024 })),
        (writer) =>
          Stream.runForEach(response.stream, (chunk) => {
            size += chunk.byteLength
            if (size > maxArchiveBytes) {
              return Effect.fail(new InstallerError({ code: "archive-limit", message: "Skill 安装包超过 50 MiB" }))
            }
            hasher.update(chunk)
            return Effect.tryPromise({
              try: () => Promise.resolve(writer.write(chunk)),
              catch: () => new InstallerError({ code: "disk-unavailable", message: "无法写入 Skill 安装包" }),
            })
          }).pipe(
            Effect.flatMap(() =>
              Effect.tryPromise({
                try: () => Promise.resolve(writer.flush()),
                catch: () => new InstallerError({ code: "disk-unavailable", message: "无法写入 Skill 安装包" }),
              }),
            ),
            Effect.mapError((error) =>
              error instanceof InstallerError
                ? error
                : new InstallerError({ code: "network-unavailable", message: "Skill 安装包下载中断" }),
            ),
          ),
        (writer) => Effect.promise(() => Promise.resolve(writer.end())).pipe(Effect.ignore),
      )
      return { sha256: hasher.digest("hex"), size }
    })

    const replace = Effect.fn("SkillMarketInstaller.replace")(function* (input: {
      source: string
      target: string
      backup: string
    }) {
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* exists(input.target)
          if (current) yield* fs.rename(input.target, input.backup)
          yield* fs.rename(input.source, input.target).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (current) yield* fs.rename(input.backup, input.target).pipe(Effect.ignore)
                return yield* Effect.fail(error)
              }),
            ),
          )
          if (current) yield* fs.remove(input.backup, { recursive: true, force: true }).pipe(Effect.ignore)
        }),
      ).pipe(
        Effect.mapError(() => new InstallerError({ code: "disk-unavailable", message: "无法原子替换 Skill 目录" })),
      )
    })

    const perform = Effect.fn("SkillMarketInstaller.perform")(function* (
      mode: "install" | "update",
      detail: SkillMarket.Detail,
      request: SkillMarket.InstallRequest,
    ) {
      const validation = validate(detail, request)
      if (validation) return yield* validation
      yield* fs
        .makeDirectory(root, { recursive: true })
        .pipe(
          Effect.mapError(() => new InstallerError({ code: "disk-unavailable", message: "无法创建全局 Skill 目录" })),
        )
      const target = path.join(root, detail.id)
      const targetExists = yield* exists(target)
      const current = targetExists ? yield* readManifest(target) : undefined
      if (
        current?.source === detail.source &&
        current.id === detail.id &&
        current.version === detail.version &&
        current.sha256 === detail.package.sha256
      ) {
        return operationResult(current, false)
      }
      if (targetExists && !current) {
        return yield* new InstallerError({ code: "not-market-owned", message: "目标目录不是市场安装的 Skill" })
      }
      if (current && (current.source !== detail.source || current.id !== detail.id)) {
        return yield* new InstallerError({ code: "version-conflict", message: "目标目录已由其他 Skill 占用" })
      }
      if (mode === "install" && current) {
        return yield* new InstallerError({ code: "version-conflict", message: "Skill 已安装，请使用更新操作" })
      }
      if (mode === "update" && !current) {
        return yield* new InstallerError({ code: "version-conflict", message: "Skill 尚未安装" })
      }

      const token = crypto.randomUUID()
      const staging = path.join(root, ".staging", token)
      const archive = path.join(staging, "package.zip")
      const extracted = path.join(staging, "extracted")
      const backup = path.join(root, `.backup-${detail.id}-${token}`)
      const transaction = Effect.gen(function* () {
        yield* fs
          .makeDirectory(staging, { recursive: true })
          .pipe(
            Effect.mapError(() => new InstallerError({ code: "disk-unavailable", message: "无法创建 Skill 暂存目录" })),
          )
        const downloaded = yield* download(detail.package.url, archive)
        if (
          downloaded.sha256 !== request.sha256 ||
          downloaded.sha256 !== detail.package.sha256 ||
          downloaded.size !== detail.package.size
        ) {
          return yield* new InstallerError({ code: "hash-mismatch", message: "Skill 安装包校验失败" })
        }
        const archiveManifest = yield* Effect.tryPromise({
          try: () => extractZip({ archive, destination: extracted, limits }),
          catch: archiveFailure,
        })
        const source = skillRoot(
          extracted,
          archiveManifest.files.map((file) => file.path),
        )
        if (source instanceof InstallerError) return yield* source
        const content = yield* fs
          .readFileStringSafe(path.join(source, "SKILL.md"))
          .pipe(Effect.mapError(() => new InstallerError({ code: "invalid-skill", message: "无法读取 Skill 定义" })))
        const markdown = content ? ConfigMarkdown.parseOption(content) : undefined
        const frontmatter = markdown ? decodeFrontmatter(markdown.data).valueOrUndefined : undefined
        if (frontmatter?.name !== detail.id) {
          return yield* new InstallerError({ code: "invalid-skill", message: "Skill 名称与目录 ID 不一致" })
        }
        const manifest: Manifest = {
          schemaVersion: 1,
          source: detail.source,
          id: detail.id,
          name: detail.name,
          version: detail.version,
          sha256: detail.package.sha256,
          installedAt: new Date().toISOString(),
          sourceUrl: detail.sourceUrl,
          loadState: "refresh-failed",
        }
        yield* writeManifest(source, manifest)
        yield* replace({ source, target, backup })
        const ready = yield* skill.reload().pipe(
          Effect.flatMap(() => writeManifest(target, { ...manifest, loadState: "ready" })),
          Effect.as(true),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            () => Effect.succeed(false),
          ),
        )
        return operationResult({ ...manifest, loadState: ready ? "ready" : "refresh-failed" }, true)
      })

      return yield* transaction.pipe(
        Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
        Effect.ensuring(
          Effect.gen(function* () {
            if (!(yield* exists(target).pipe(Effect.orElseSucceed(() => false)))) return
            yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
          }),
        ),
      )
    })

    const installed = Effect.fn("SkillMarketInstaller.installed")(function* () {
      if (!(yield* exists(root))) return []
      const names = yield* fs
        .readDirectory(root)
        .pipe(Effect.mapError(() => new InstallerError({ code: "disk-unavailable", message: "无法读取已安装 Skill" })))
      const manifests = yield* Effect.forEach(names, (name) => readManifest(path.join(root, name)), {
        concurrency: 4,
      })
      return manifests
        .filter((manifest): manifest is Manifest => manifest !== undefined)
        .map((manifest) => operationResult(manifest, false).installed)
        .toSorted((a, b) => a.name.localeCompare(b.name))
    })

    const uninstall = (key: { source: SkillMarket.Source; id: string }) =>
      mutate(key.id)(
        Effect.gen(function* () {
          if (!safeID(key.id)) {
            return yield* new InstallerError({ code: "invalid-skill", message: "Skill ID 无效" })
          }
          const target = path.join(root, key.id)
          const manifest = yield* readManifest(target)
          if (!manifest || manifest.source !== key.source || manifest.id !== key.id) {
            return yield* new InstallerError({ code: "not-market-owned", message: "只可卸载市场管理的 Skill" })
          }
          yield* fs
            .remove(target, { recursive: true })
            .pipe(Effect.mapError(() => new InstallerError({ code: "disk-unavailable", message: "无法卸载 Skill" })))
          yield* skill.reload().pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              () => Effect.fail(new InstallerError({ code: "refresh-failed", message: "Skill 已卸载，但刷新失败" })),
            ),
          )
        }),
      )

    const refresh = (key: { source: SkillMarket.Source; id: string }) =>
      mutate(key.id)(
        Effect.gen(function* () {
          if (!safeID(key.id)) {
            return yield* new InstallerError({ code: "invalid-skill", message: "Skill ID 无效" })
          }
          const target = path.join(root, key.id)
          const manifest = yield* readManifest(target)
          if (!manifest || manifest.source !== key.source || manifest.id !== key.id) {
            return yield* new InstallerError({ code: "not-market-owned", message: "只可刷新市场管理的 Skill" })
          }
          const ready = yield* skill.reload().pipe(
            Effect.flatMap(() => writeManifest(target, { ...manifest, loadState: "ready" })),
            Effect.as(true),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              () => Effect.succeed(false),
            ),
          )
          if (ready) return
          yield* writeManifest(target, { ...manifest, loadState: "refresh-failed" }).pipe(Effect.ignore)
          return yield* new InstallerError({ code: "refresh-failed", message: "Skill 刷新失败" })
        }),
      )

    return Service.of({
      install: (detail, request) => mutate(detail.id)(perform("install", detail, request)),
      update: (detail, request) => mutate(detail.id)(perform("update", detail, request)),
      uninstall,
      installed,
      refresh,
    })
  }),
)

function mutate(id: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => operations.withPermit(locks.withLock(id)(effect))
}

function validate(detail: SkillMarket.Detail, request: SkillMarket.InstallRequest) {
  if (!safeID(detail.id) || detail.id !== request.id) {
    return new InstallerError({ code: "invalid-skill", message: "Skill ID 无效" })
  }
  if (detail.source !== request.source || detail.version !== request.version) {
    return new InstallerError({ code: "version-conflict", message: "Skill 目录版本已变化" })
  }
  if (detail.package.sha256 !== request.sha256) {
    return new InstallerError({ code: "hash-mismatch", message: "Skill 安装包摘要不一致" })
  }
  if (detail.delisted) return new InstallerError({ code: "skill-delisted", message: "Skill 已下架" })
  if (detail.risk !== "safe" && request.riskConfirmed !== true) {
    return new InstallerError({ code: "risk-confirmation-required", message: "安装该 Skill 前需要确认风险" })
  }
  if (detail.package.size > maxArchiveBytes) {
    return new InstallerError({ code: "archive-limit", message: "Skill 安装包超过 50 MiB" })
  }
  if (!URL.canParse(detail.package.url) || new URL(detail.package.url).protocol !== "https:") {
    return new InstallerError({ code: "network-unavailable", message: "Skill 安装包地址必须使用 HTTPS" })
  }
}

function safeID(id: string) {
  return (
    id.length > 0 &&
    id !== "." &&
    id !== ".." &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("\0") &&
    !id.includes("?") &&
    !id.includes("#") &&
    !URL.canParse(id) &&
    !/^[a-z]:/i.test(id)
  )
}

function skillRoot(extracted: string, files: readonly string[]) {
  const manifests = files.filter((file) => path.posix.basename(file) === "SKILL.md")
  if (manifests.length !== 1) {
    return new InstallerError({ code: "invalid-skill", message: "安装包必须包含一个 SKILL.md" })
  }
  if (manifests[0] === "SKILL.md") return extracted
  const segments = files.map((file) => file.split("/")[0])
  if (!segments[0] || !segments.every((segment) => segment === segments[0])) {
    return new InstallerError({ code: "invalid-skill", message: "安装包目录结构无效" })
  }
  if (manifests[0] !== `${segments[0]}/SKILL.md`) {
    return new InstallerError({ code: "invalid-skill", message: "SKILL.md 必须位于安装包根目录" })
  }
  return path.join(extracted, segments[0])
}

function archiveFailure(error: unknown) {
  if (error instanceof ArchiveLimitError) {
    return new InstallerError({ code: "archive-limit", message: "Skill 安装包超过安全限制" })
  }
  if (error instanceof UnsafeArchiveError) {
    return new InstallerError({ code: "unsafe-archive", message: "Skill 安装包包含不安全文件" })
  }
  if (error instanceof InstallerError) return error
  return new InstallerError({ code: "invalid-skill", message: "Skill 安装包无法解压" })
}

function operationResult(manifest: Manifest, changed: boolean): SkillMarket.OperationResult {
  return {
    changed,
    installed: {
      source: manifest.source,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      installedAt: manifest.installedAt,
      updateAvailable: false,
      loadState: manifest.loadState,
    },
  }
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Global.node, FSUtil.node, SkillV2.node, httpClient],
})
