import { describe, expect, test } from "bun:test"
import { resolveUpgrade } from "../../../src/cli/cmd/upgrade"
import { Installation } from "../../../src/installation"

describe("upgrade command resolution", () => {
  test("rejects explicit unsupported methods before detection or latest lookup", async () => {
    for (const method of ["curl", "brew", "scoop", "choco", "unknown"]) {
      const calls: string[] = []
      const result = resolveUpgrade(
        { method },
        {
          method: async () => {
            calls.push("method")
            throw new Error("method must not run")
          },
          latest: async () => {
            calls.push("latest")
            throw new Error("latest must not run")
          },
        },
      )
      await expect(result).rejects.toEqual(
        new Installation.UpgradeFailedError({
          stderr: `Ruying Code does not support upgrades from ${method}. Run: npm install -g @ruying/ruying-code --registry=https://nexus.gwm.cn/repository/npm-group/`,
        }),
      )
      expect(calls).toEqual([])
    }
  })

  test("uses a supported explicit method without detection", async () => {
    const calls: string[] = []
    const result = await resolveUpgrade(
      { method: "npm" },
      {
        method: async () => {
          calls.push("method")
          throw new Error("method must not run")
        },
        latest: async (method) => {
          calls.push(`latest:${method}`)
          return "1.2.3"
        },
      },
    )
    expect(result).toEqual({ method: "npm", target: "1.2.3" })
    expect(calls).toEqual(["latest:npm"])
  })

  test("normalizes one leading v in an explicit target without dependency calls", async () => {
    const calls: string[] = []
    const result = await resolveUpgrade(
      { method: "npm", target: "v1.2.3" },
      {
        method: async () => {
          calls.push("method")
          return "npm"
        },
        latest: async () => {
          calls.push("latest")
          return "9.9.9"
        },
      },
    )
    expect(result).toEqual({ method: "npm", target: "1.2.3" })
    expect(calls).toEqual([])
  })

  test("rejects other explicit target forms before dependency calls", async () => {
    const invalid = [
      "vv1.2.3",
      "^1.2.3",
      "latest",
      "file:../tool",
      "npm:other@1.2.3",
      "https://example.test/tool.tgz",
      " 1.2.3 ",
    ]
    for (const target of invalid) {
      const calls: string[] = []
      const result = resolveUpgrade(
        { method: "npm", target },
        {
          method: async () => {
            calls.push("method")
            return "npm"
          },
          latest: async () => {
            calls.push("latest")
            return "9.9.9"
          },
        },
      )
      await expect(result).rejects.toBeInstanceOf(Installation.UpgradeFailedError)
      expect(calls).toEqual([])
    }
  })
})
