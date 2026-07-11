import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("prefers branded inline auth with legacy fallback", () =>
    Effect.gen(function* () {
      const previousBranded = process.env.RUYING_CODE_AUTH_CONTENT
      const previousLegacy = process.env.OPENCODE_AUTH_CONTENT
      process.env.RUYING_CODE_AUTH_CONTENT = JSON.stringify({ ruying: { type: "api", key: "branded" } })
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ ruying: { type: "api", key: "legacy" } })
      try {
        const auth = yield* Auth.Service
        expect(yield* auth.get("ruying")).toMatchObject({ key: "branded" })
        delete process.env.RUYING_CODE_AUTH_CONTENT
        expect(yield* auth.get("ruying")).toMatchObject({ key: "legacy" })
      } finally {
        if (previousBranded === undefined) delete process.env.RUYING_CODE_AUTH_CONTENT
        else process.env.RUYING_CODE_AUTH_CONTENT = previousBranded
        if (previousLegacy === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previousLegacy
      }
    }),
  )

  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("compareAndSet replaces only the exact current credential", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const previous = { type: "api" as const, key: "old-key", metadata: { account: "one" } }
      const attempted = { type: "api" as const, key: "attempt-key", metadata: { account: "two" } }
      yield* auth.set("ruying", attempted)

      expect(yield* auth.compareAndSet("ruying", { ...attempted, key: "different" }, previous)).toBe(false)
      expect(yield* auth.get("ruying")).toEqual(attempted)
      expect(yield* auth.compareAndSet("ruying", attempted, previous)).toBe(true)
      expect(yield* auth.get("ruying")).toEqual(previous)
      expect(yield* auth.compareAndSet("ruying", previous, undefined)).toBe(true)
      expect(yield* auth.get("ruying")).toBeUndefined()
    }),
  )
})
