import { expect, test } from "bun:test"
import { OpenCode } from "../src"

test("generated client exposes every local Skill market operation", () => {
  const client = OpenCode.make({ baseUrl: "http://127.0.0.1:1" })

  expect(Object.keys(client.skillMarket).toSorted()).toEqual([
    "detail",
    "facets",
    "install",
    "installed",
    "list",
    "refresh",
    "uninstall",
    "update",
    "updates",
  ])
})
