import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context, Duration } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"
import { Brand } from "@opencode-ai/core/brand/brand"

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export function normalizeVersion(version: string, allowVPrefix = false) {
  const candidate = allowVPrefix && version.startsWith("v") ? version.slice(1) : version
  const valid = semver.valid(candidate)
  if (!valid || valid !== candidate) return
  return valid
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `opencode/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

const NpmPackage = Schema.Struct({ version: Schema.String })
const installRegistry = "https://nexus.gwm.cn/repository/npm-group/"

export interface Interface {
  readonly info: () => Effect.Effect<Info, UpgradeFailedError>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string, UpgradeFailedError>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

const makeLayer = (options: { latestTimeout?: Duration.Input } = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
      const appProcess = yield* AppProcess.Service

      const text = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const result = yield* appProcess.run(
            ChildProcess.make(cmd[0], cmd.slice(1), {
              cwd: opts?.cwd,
              env: opts?.env,
              extendEnv: true,
            }),
          )
          return result.stdout.toString("utf8")
        },
        Effect.catch(() => Effect.succeed("")),
      )

      const run = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const result = yield* appProcess.run(
            ChildProcess.make(cmd[0], cmd.slice(1), {
              cwd: opts?.cwd,
              env: opts?.env,
              extendEnv: true,
            }),
          )
          return {
            code: result.exitCode,
            stdout: result.stdout.toString("utf8"),
            stderr: result.stderr.toString("utf8"),
          }
        },
        Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
      )

      const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
        if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
        return `Upgrade failed for ${method}.`
      }

      const result: Interface = {
        info: Effect.fn("Installation.info")(function* () {
          return {
            version: InstallationVersion,
            latest: yield* result.latest(),
          }
        }),
        method: Effect.fn("Installation.method")(function* () {
          if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl" as Method
          if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
          const exec = process.execPath.toLowerCase()

          const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
            { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
            { name: "yarn", command: () => text(["yarn", "global", "list"]) },
            { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
            { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
            { name: "brew", command: () => text(["brew", "list", "--formula", "opencode"]) },
            { name: "scoop", command: () => text(["scoop", "list", "opencode"]) },
            { name: "choco", command: () => text(["choco", "list", "--limit-output", "opencode"]) },
          ]

          checks.sort((a, b) => {
            const aMatches = exec.includes(a.name)
            const bMatches = exec.includes(b.name)
            if (aMatches && !bMatches) return -1
            if (!aMatches && bMatches) return 1
            return 0
          })

          for (const check of checks) {
            const output = yield* check.command()
            const installedNames =
              check.name === "brew" || check.name === "choco" || check.name === "scoop"
                ? [Brand.profile.legacyCliName]
                : [Brand.profile.packageName, "opencode-ai"]
            if (installedNames.some((name) => output.includes(name))) {
              return check.name
            }
          }

          return "unknown" as Method
        }),
        latest: Effect.fn("Installation.latest")(
          function* () {
            const response = yield* httpOk.execute(
              HttpClientRequest.get(
                `${installRegistry}${encodeURIComponent(Brand.profile.packageName)}/${InstallationChannel}`,
              ).pipe(HttpClientRequest.acceptJson),
            )
            const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
            const version = normalizeVersion(data.version)
            if (!version) {
              return yield* new UpgradeFailedError({
                stderr: `${Brand.profile.englishName} received an invalid version from Nexus. Retry with an exact semantic version.`,
              })
            }
            return version
          },
          Effect.catch((error) =>
            error instanceof UpgradeFailedError
              ? Effect.fail(error)
              : Effect.fail(
                  new UpgradeFailedError({
                    stderr: `${Brand.profile.englishName} could not read the latest version from Nexus. Check Nexus access and retry.`,
                  }),
                ),
          ),
          Effect.timeoutOrElse({
            duration: options.latestTimeout ?? Duration.seconds(30),
            orElse: () =>
              Effect.fail(
                new UpgradeFailedError({
                  stderr: `${Brand.profile.englishName} could not check Nexus for updates in time. Check Nexus access and retry, or run ${Brand.profile.cliName} upgrade 1.2.3 with an exact version.`,
                }),
              ),
          }),
        ),
        upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
          const version = normalizeVersion(target)
          if (!version) {
            return yield* new UpgradeFailedError({
              stderr: `${Brand.profile.englishName} refused invalid version "${target}". Use an exact semantic version such as 1.2.3.`,
            })
          }
          const packageVersion = `${Brand.profile.packageName}@${version}`
          const command =
            m === "npm"
              ? ["npm", "install", "-g", packageVersion]
              : m === "pnpm"
                ? ["pnpm", "install", "-g", packageVersion]
                : m === "bun"
                  ? ["bun", "install", "-g", packageVersion]
                  : m === "yarn"
                    ? ["yarn", "global", "add", packageVersion]
                    : undefined
          if (!command) {
            return yield* new UpgradeFailedError({
              stderr: `${Brand.profile.englishName} does not support upgrades from ${m}. Run: npm install -g ${packageVersion} --registry=${installRegistry}`,
            })
          }
          const upgradeResult = yield* run(command, { env: { NPM_CONFIG_REGISTRY: installRegistry } })
          if (upgradeResult.code !== 0) {
            return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, upgradeResult) })
          }
          yield* Effect.logInfo("upgraded", {
            method: m,
            target,
            stdout: upgradeResult.stdout,
            stderr: upgradeResult.stderr,
          })
          yield* text([process.execPath, "--version"])
        }),
      }

      return Service.of(result)
    }),
  )

export function makeNode(options?: { latestTimeout?: Duration.Input }) {
  return LayerNode.make({ service: Service, layer: makeLayer(options), deps: [httpClient, AppProcess.node] })
}

export const node = makeNode()

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
