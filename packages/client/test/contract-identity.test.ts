import { expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location as CoreLocation } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput as CoreSessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage as CoreSessionMessage } from "@opencode-ai/core/session/message"
import { Prompt as CorePrompt } from "@opencode-ai/core/session/prompt"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Model } from "@opencode-ai/schema/model"
import { Project } from "@opencode-ai/schema/project"
import { Provider } from "@opencode-ai/schema/provider"
import { Prompt } from "@opencode-ai/schema/prompt"
import { Session } from "@opencode-ai/schema/session"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Workspace } from "@opencode-ai/schema/workspace"
import { Api } from "@opencode-ai/server/api"
import { compile, emitEffect, emitPromise } from "@opencode-ai/httpapi-codegen"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { ClientApi, endpointNames, groupNames, omitEndpoints } from "../src/contract"

test("Core and Server reuse the authoritative Schema and Protocol values", () => {
  expect(AgentV2.ID).toBe(Agent.ID)
  expect(CoreLocation.Ref).toBe(Location.Ref)
  expect(ModelV2.Ref).toBe(Model.Ref)
  expect(SessionV2.Info).toBe(Session.Info)
  expect(CoreSessionInput.Admitted).toBe(SessionInput.Admitted)
  expect(CoreSessionMessage.Message).toBe(SessionMessage.Message)
  expect(CorePrompt).toBe(Prompt)
  expect(Api.groups["server.session"].identifier).toBe("server.session")
  expect(Object.keys(ClientApi.groups)).toEqual(Object.keys(Api.groups))
  expect(Session.ID.create()).toStartWith("ses_")
  expect(Project.ID.global).toBe("global")
  expect(Provider.ID.anthropic).toBe("anthropic")
  expect(Workspace.ID.create()).toStartWith("wrk_")
})

test("client and Server contracts generate identically", () => {
  const server = compile(Api, { groupNames, endpointNames, omitEndpoints })
  const client = compile(ClientApi, { groupNames, endpointNames, omitEndpoints })

  expect(emitPromise(client)).toEqual(emitPromise(server))
})

test("generated market URL schema decodes exactly like the source contract", () => {
  const group = HttpApiGroup.make("market").add(
    HttpApiEndpoint.get("get", "/market", { success: SkillMarket.MarketPageUrl }),
  )
  const source = emitEffect(compile(HttpApi.make("test").add(group))).files.find((file) => file.path === "market.ts")
  const expression = source?.content.match(/^const Endpoint0Success = (.+)$/m)?.[1]
  if (expression === undefined) throw new Error("Expected generated market URL schema")
  const emitted = new Function("Schema", `return ${expression}`)(Schema) as Schema.Top

  for (const [url, accepted] of [
    ["https://skillhub.cn/skills/code-review", true],
    ["http://localhost:4211/skills/code-review", true],
    ["http://[::1]:4211/skills/code-review", true],
    ["http://10.1.2.3/skills/code-review", true],
    ["http://172.16.2.3/skills/code-review", true],
    ["http://192.168.2.3/skills/code-review", true],
    ["http://127.0.0.1/skills/code-review", true],
    ["http://127.1/skills/code-review", false],
    ["http://0x7f000001/skills/code-review", false],
    ["http://8.8.8.8/skills/code-review", false],
    ["https://user:password@skillhub.cn/skills/code-review", false],
    ["https://%/skills/code-review", false],
    ["https://[not-ipv6]/skills/code-review", false],
    ["https://skillhub.cn:99999/skills/code-review", false],
  ] as const) {
    expect(Schema.decodeUnknownExit(SkillMarket.MarketPageUrl)(url)._tag === "Success").toBe(accepted)
    expect(Schema.decodeUnknownExit(emitted)(url)._tag === "Success").toBe(accepted)
  }
})

test("shared DTO schemas construct and decode plain objects", () => {
  const made = Prompt.make({ text: "hello" })
  const decoded = Schema.decodeUnknownSync(Prompt)({ text: "hello" })
  const content = Schema.decodeUnknownSync(SessionMessage.AssistantText)({ type: "text", id: "part_1", text: "hi" })

  expect(Object.getPrototypeOf(made)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(content)).toBe(Object.prototype)
  expect(Prompt.ast.annotations?.identifier).toBe("Prompt")
  expect(SessionMessage.AssistantText.ast.annotations?.identifier).toBe("Session.Message.Assistant.Text")
  expect(CoreSessionMessage.AssistantText).toBe(SessionMessage.AssistantText)
})
