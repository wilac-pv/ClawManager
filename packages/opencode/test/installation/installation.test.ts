import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Duration, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response | Effect.Effect<Response>) {
  const client = HttpClient.make((request) => {
    const result = handler(request)
    return (Effect.isEffect(result) ? result : Effect.succeed(result)).pipe(
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    )
  })
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (
    cmd: string,
    args: readonly string[],
    env: Record<string, string | undefined>,
  ) => string | { code: number; stdout?: string; stderr?: string } = () => "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [], std?.options.env ?? {})
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response | Effect.Effect<Response>,
  spawnHandler?: (
    cmd: string,
    args: readonly string[],
    env: Record<string, string | undefined>,
  ) => string | { code: number; stdout?: string; stderr?: string },
  options?: { latestTimeout?: Duration.Input },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.makeNode(options), [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("method", () => {
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => (cmd === "npm" ? "@ruying/ruying-code@1.2.3" : ""),
      ),
    ).effect("detects the scoped npm package", () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.method()).toBe("npm")
      }),
    )

    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => (cmd === "npm" ? "opencode-ai@1.2.3" : ""),
      ),
    ).effect("keeps detecting the legacy npm package", () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.method()).toBe("npm")
      }),
    )
  })

  describe("latest", () => {
    const interruptions: boolean[] = []
    testEffect(
      testLayer(
        () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interruptions.push(true)
              }),
            ),
          ),
        undefined,
        { latestTimeout: "10 millis" },
      ),
    ).effect("times out and interrupts a never-completing nexus request", () =>
      Effect.gen(function* () {
        const fiber = yield* Installation.use.latest("npm").pipe(Effect.forkChild)
        yield* TestClock.adjust("10 millis")
        const result = fiber.pollUnsafe()
        if (!result) {
          yield* Fiber.interrupt(fiber)
          expect(result).toBeDefined()
          return
        }
        const error = yield* Fiber.join(fiber).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe(
          "Ruying Code could not check Nexus for updates in time. Check Nexus access and retry, or run ruying-code upgrade 1.2.3 with an exact version.",
        )
        expect(interruptions).toEqual([true])
      }),
    )

    const nexusCalls: string[] = []
    testEffect(
      testLayer((request) => {
        nexusCalls.push(request.url)
        return jsonResponse({ version: "1.2.3" })
      }),
    ).effect("checks the ruying package in the configured nexus registry", () =>
      Effect.gen(function* () {
        const version = yield* Installation.use.latest("npm")
        expect(version).toBe("1.2.3")
        expect(nexusCalls[0]).toContain("%40ruying%2Fruying-code")
      }),
    )

    const methodCalls: string[] = []
    testEffect(
      testLayer((request) => {
        methodCalls.push(request.url)
        return jsonResponse({ version: "2.3.4" })
      }),
    ).effect("uses the nexus package for every detected installation method", () =>
      Effect.gen(function* () {
        const methods: Installation.Method[] = [
          "curl",
          "npm",
          "yarn",
          "pnpm",
          "bun",
          "brew",
          "scoop",
          "choco",
          "unknown",
        ]
        yield* Effect.forEach(methods, (method) => Installation.use.latest(method))
        expect(methodCalls).toHaveLength(methods.length)
        expect(methodCalls).toEqual(
          methods.map(() => `https://nexus.gwm.cn/repository/npm-group/%40ruying%2Fruying-code/${InstallationChannel}`),
        )
      }),
    )

    const invalidLatest = [
      "https://example.test/tool.tgz",
      "file:../tool",
      "npm:other@1.2.3",
      "^1.2.3",
      "latest",
      " 1.2.3 ",
      "v1.2.3",
    ]
    testEffect(testLayer(() => jsonResponse({ version: invalidLatest.shift() }))).effect(
      "rejects non-canonical nexus versions",
      () =>
        Effect.gen(function* () {
          const errors = yield* Effect.forEach(Array(7), () => Effect.flip(Installation.use.latest("npm")))
          expect(errors.every((error) => error instanceof Installation.UpgradeFailedError)).toBe(true)
          expect(errors.map((error) => error.stderr)).toEqual(
            Array(7).fill("Ruying Code received an invalid version from Nexus. Retry with an exact semantic version."),
          )
        }),
    )
  })

  describe("upgrade", () => {
    const invalidVersionCommands: string[] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => {
          invalidVersionCommands.push(cmd)
          return ""
        },
      ),
    ).effect("rejects non-canonical versions before spawning a package manager", () =>
      Effect.gen(function* () {
        const versions = [
          "https://example.test/tool.tgz",
          "file:../tool",
          "npm:other@1.2.3",
          "^1.2.3",
          "latest",
          " 1.2.3 ",
          "v1.2.3",
        ]
        const errors = yield* Effect.forEach(versions, (version) =>
          Effect.flip(Installation.use.upgrade("npm", version)),
        )
        expect(errors.every((error) => error instanceof Installation.UpgradeFailedError)).toBe(true)
        expect(errors.map((error) => error.stderr)).toEqual(
          versions.map(
            (version) =>
              `Ruying Code refused invalid version "${version}". Use an exact semantic version such as 1.2.3.`,
          ),
        )
        expect(invalidVersionCommands).toEqual([])
      }),
    )

    const registries: Array<string | undefined> = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, _args, env) => {
          if (["npm", "pnpm", "bun", "yarn"].includes(cmd)) registries.push(env.NPM_CONFIG_REGISTRY)
          return ""
        },
      ),
    ).effect("pins package manager upgrades to the nexus group", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("npm", "1.2.3")
        yield* Installation.use.upgrade("pnpm", "1.2.3")
        yield* Installation.use.upgrade("bun", "1.2.3")
        yield* Installation.use.upgrade("yarn", "1.2.3")
        expect(registries).toEqual(Array(4).fill("https://nexus.gwm.cn/repository/npm-group/"))
      }),
    )

    const commands: Array<[string, readonly string[]]> = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          commands.push([cmd, args])
          return ""
        },
      ),
    ).effect("upgrades the scoped package", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("npm", "1.2.3")
        expect(commands).toContainEqual(["npm", ["install", "-g", "@ruying/ruying-code@1.2.3"]])
      }),
    )

    const packageCommands: Array<[string, readonly string[]]> = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          packageCommands.push([cmd, args])
          return ""
        },
      ),
    ).effect("upgrades with every supported package manager", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("npm", "1.2.3")
        yield* Installation.use.upgrade("pnpm", "1.2.3")
        yield* Installation.use.upgrade("bun", "1.2.3")
        yield* Installation.use.upgrade("yarn", "1.2.3")
        expect(packageCommands).toEqual([
          ["npm", ["install", "-g", "@ruying/ruying-code@1.2.3"]],
          [process.execPath, ["--version"]],
          ["pnpm", ["install", "-g", "@ruying/ruying-code@1.2.3"]],
          [process.execPath, ["--version"]],
          ["bun", ["install", "-g", "@ruying/ruying-code@1.2.3"]],
          [process.execPath, ["--version"]],
          ["yarn", ["global", "add", "@ruying/ruying-code@1.2.3"]],
          [process.execPath, ["--version"]],
        ])
      }),
    )

    const legacyCommands: Array<[string, readonly string[]]> = []
    const legacyRequests: string[] = []
    testEffect(
      testLayer(
        (request) => {
          legacyRequests.push(request.url)
          return new Response("legacy installer", { status: 200 })
        },
        (cmd, args) => {
          legacyCommands.push([cmd, args])
          return ""
        },
      ),
    ).effect("returns branded nexus instructions for unsupported legacy methods", () =>
      Effect.gen(function* () {
        const methods: Installation.Method[] = ["curl", "brew", "scoop", "choco", "unknown"]
        const errors = yield* Effect.forEach(methods, (method) =>
          Effect.flip(Installation.use.upgrade(method, "1.2.3")),
        )
        expect(errors.every((error) => error instanceof Installation.UpgradeFailedError)).toBe(true)
        expect(errors.map((error) => error.stderr)).toEqual(
          methods.map(
            (method) =>
              `Ruying Code does not support upgrades from ${method}. Run: npm install -g @ruying/ruying-code@1.2.3 --registry=https://nexus.gwm.cn/repository/npm-group/`,
          ),
        )
        expect(legacyRequests).toEqual([])
        expect(legacyCommands).toEqual([])
      }),
    )

    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => {
          if (cmd === "npm") return { code: 1, stderr: "token=secret command output" }
          return ""
        },
      ),
    ).effect("returns sanitized typed errors for failed package upgrades", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(error.stderr).not.toContain("command output")
      }),
    )
  })
})
