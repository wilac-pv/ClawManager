import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("uses the ruying storage name", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "ruying-code"))
    expect(Global.Path.config.endsWith("ruying-code")).toBe(true)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})
