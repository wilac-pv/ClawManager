import { expect, test } from "bun:test"
import { requireRuyingLogin, requireRuyingProvider } from "@/auth/ruying-gate"
import { getRuyingSessionStatus } from "@/auth/ruying-session"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Stream } from "effect"
import type { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTest } from "../fake/provider"

function run(auth: Auth.Info | undefined, marker?: unknown) {
  return Effect.runPromise(
    requireRuyingLogin().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Auth.Service, { get: () => Effect.succeed(auth) }),
          Layer.mock(Config.Service, {
            get: () =>
              Effect.succeed({
                ...(marker === undefined ? {} : { provider: { ruying: { options: { ruyingUser: marker } } } }),
              }),
          }),
        ),
      ),
    ),
  )
}

test("requires both a ruying key and persisted identity marker", async () => {
  await expect(run(undefined, {})).rejects.toThrow("ruying-code login")
  await expect(run({ type: "api", key: "sk", metadata: { employeeId: "GW001" } })).rejects.toThrow("ruying-code login")
  await expect(run({ type: "api", key: "sk" }, {})).rejects.toThrow("ruying-code login")
  await expect(run({ type: "api", key: "sk" }, { employeeId: "GW001" })).resolves.toBeUndefined()
})

test("model execution accepts only the Ruying provider", async () => {
  await expect(Effect.runPromise(requireRuyingProvider("ruying"))).resolves.toBeUndefined()
  await expect(Effect.runPromise(requireRuyingProvider("test"))).rejects.toMatchObject({
    _tag: "RuyingProviderRequiredError",
    providerID: "test",
  })
})

test("LLM rejects missing SSO before touching provider or client work", async () => {
  const result = await directLLM({ providerID: "ruying", auth: { type: "api", key: "credential-only" } })

  expect(result.exit).toMatchObject({ _tag: "Failure" })
  expect(String(result.exit)).toContain("RuyingLoginRequiredError")
  expect(result.touches).toEqual([])
})

test("LLM rejects a secondary provider before touching provider or client work", async () => {
  const result = await directLLM({
    providerID: "secondary",
    auth: { type: "api", key: "sk", metadata: { employeeId: "GW001" } },
    marker: { employeeId: "GW001" },
  })

  expect(result.exit).toMatchObject({ _tag: "Failure" })
  expect(String(result.exit)).toContain("RuyingProviderRequiredError")
  expect(result.touches).toEqual([])
})

test("reports the authoritative user only when credential and marker are both present", async () => {
  const marker = { employeeId: "GW001", displayName: "张三" }

  await expect(status(undefined, marker)).resolves.toEqual({ loggedIn: false })
  await expect(status({ type: "api", key: "" }, marker)).resolves.toEqual({ loggedIn: false })
  await expect(status({ type: "api", key: "sk-ruying" })).resolves.toEqual({ loggedIn: false })
  await expect(status({ type: "api", key: "sk-ruying" }, marker)).resolves.toEqual({ loggedIn: true, user: marker })
})

function status(auth: Auth.Info | undefined, marker?: unknown) {
  return Effect.runPromise(
    getRuyingSessionStatus().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Auth.Service, { get: () => Effect.succeed(auth) }),
          Layer.mock(Config.Service, {
            get: () =>
              Effect.succeed({
                ...(marker === undefined ? {} : { provider: { ruying: { options: { ruyingUser: marker } } } }),
              }),
          }),
        ),
      ),
    ),
  )
}

async function directLLM(input: { providerID: string; auth?: Auth.Info; marker?: unknown }) {
  const touches: string[] = []
  const model = ProviderTest.model({
    providerID: ProviderV2.ID.make(input.providerID),
    id: ModelV2.ID.make("test-model"),
  })
  const provider = ProviderTest.fake({
    model,
    getLanguage: () => {
      touches.push("language")
      return Effect.die(new Error("provider language touched"))
    },
    getProvider: () => {
      touches.push("provider")
      return Effect.die(new Error("provider metadata touched"))
    },
  })
  const layer = AppNodeBuilder.build(LLM.node, [
    [Provider.node, provider.layer],
    [Auth.node, Layer.mock(Auth.Service, { get: () => Effect.succeed(input.auth) })],
    [
      Config.node,
      Layer.mock(Config.Service, {
        get: () =>
          Effect.succeed({
            ...(input.marker === undefined ? {} : { provider: { ruying: { options: { ruyingUser: input.marker } } } }),
          }),
      }),
    ],
  ])
  const sessionID = SessionID.make("session-ruying-gate")
  const agent = {
    name: "test",
    mode: "primary",
    permission: [],
    options: {},
  } satisfies Agent.Info
  const user = {
    id: MessageID.make("msg_user-ruying-gate"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: agent.name,
    model: { providerID: model.providerID, modelID: model.id },
  } satisfies SessionV1.User
  const exit = await Effect.runPromise(
    LLM.Service.use((llm) =>
      llm.stream({ user, sessionID, model, agent, system: [], messages: [], tools: {} }).pipe(Stream.runDrain),
    ).pipe(Effect.provide(layer), Effect.exit),
  )
  return { exit, touches }
}
