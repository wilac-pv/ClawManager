import { expect, test } from "bun:test"
import path from "node:path"
import { parse } from "jsonc-parser"
import { removeRuyingIdentity, runLogin, runLogout } from "@/cli/cmd/ruying-auth"
import { tmpdir } from "../../fixture/fixture"

test("login always selects ruying", async () => {
  const calls: string[] = []
  await runLogin({
    loginProvider: async (id) => {
      calls.push(id)
    },
  })
  expect(calls).toEqual(["ruying"])
})

test("logout removes only ruying credentials", async () => {
  const removed: string[] = []
  await runLogout({
    remove: async (id) => {
      removed.push(id)
    },
  })
  expect(removed).toEqual(["ruying"])
})

test("logout identity cleanup preserves unrelated JSONC content", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "ruying-code.jsonc")
  await Bun.write(
    file,
    `{
  // keep this comment
  "theme": "opencode",
  "provider": {
    "ruying": {
      "options": {
        "baseURL": "https://gateway/v1",
        "ruyingUser": { "employeeId": "GW001", "displayName": "张三", "email": "" }
      }
    },
    "other": { "options": { "apiKey": "keep" } }
  }
}
`,
  )

  await removeRuyingIdentity(file)

  const source = await Bun.file(file).text()
  const config = parse(source)
  expect(source).toContain("// keep this comment")
  expect(config.theme).toBe("opencode")
  expect(config.provider.ruying.options).toEqual({ baseURL: "https://gateway/v1" })
  expect(config.provider.other.options.apiKey).toBe("keep")
})
