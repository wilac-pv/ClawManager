import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
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
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (
    cmd: string,
    args: readonly string[],
    env: Record<string, string | undefined>,
  ) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
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
  })

  describe("upgrade", () => {
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
