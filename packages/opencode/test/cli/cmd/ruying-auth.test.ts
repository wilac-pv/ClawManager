import { expect, test } from "bun:test"
import { chmod, lstat, mkdir, stat, symlink } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { parse } from "jsonc-parser"
import { runLogin, runLogout } from "@/cli/cmd/ruying-auth"
import { logoutRuying, prepareRuyingIdentityRemoval, removeRuyingIdentity } from "@/auth/ruying-session"
import { requirePluginAuthSuccess } from "@/cli/cmd/providers"
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

test.skipIf(process.platform === "win32")("logout identity cleanup preserves config symlink and mode", async () => {
  await using tmp = await tmpdir()
  const backing = path.join(tmp.path, "backing.jsonc")
  const link = path.join(tmp.path, "ruying-code.jsonc")
  await Bun.write(backing, '{\n  // keep\n  "provider": { "ruying": { "options": { "ruyingUser": {} } } }\n}\n')
  await chmod(backing, 0o600)
  await symlink(backing, link)

  await removeRuyingIdentity(link)

  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect((await stat(backing)).mode & 0o777).toBe(0o600)
  expect(await Bun.file(backing).text()).toContain("// keep")
  expect(parse(await Bun.file(backing).text()).provider.ruying.options.ruyingUser).toBeUndefined()
})

test("malformed config fails before logout removes credentials", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "ruying-code.jsonc")
  await Bun.write(file, '{ "provider": ')
  let removed = false

  await expect(
    Effect.runPromise(
      logoutRuying({
        prepareIdentity: () => prepareRuyingIdentityRemoval(file),
        get: () => Effect.succeed({ type: "api" as const, key: "secret" }),
        remove: () => Effect.sync(() => (removed = true)),
        set: () => Effect.void,
      }),
    ),
  ).rejects.toMatchObject({ _tag: "RuyingSessionLogoutError" })
  expect(removed).toBe(false)
})

test("true missing config remains a valid logout", async () => {
  await using tmp = await tmpdir()
  let removed = false

  await Effect.runPromise(
    logoutRuying({
      prepareIdentity: () => prepareRuyingIdentityRemoval(path.join(tmp.path, "missing.jsonc")),
      get: () => Effect.succeed({ type: "api" as const, key: "secret" }),
      remove: () => Effect.sync(() => (removed = true)),
      set: () => Effect.die("unexpected restore"),
    }),
  )

  expect(removed).toBe(true)
})

test.skipIf(process.platform === "win32")("inaccessible config fails before logout removes credentials", async () => {
  await using tmp = await tmpdir()
  const locked = path.join(tmp.path, "locked")
  const file = path.join(locked, "ruying-code.jsonc")
  await mkdir(locked)
  await Bun.write(file, "{}")
  let removed = false
  await chmod(locked, 0o000)

  try {
    await expect(
      Effect.runPromise(
        logoutRuying({
          prepareIdentity: () => prepareRuyingIdentityRemoval(file),
          get: () => Effect.succeed({ type: "api" as const, key: "secret" }),
          remove: () => Effect.sync(() => (removed = true)),
          set: () => Effect.void,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "RuyingSessionLogoutError" })
  } finally {
    await chmod(locked, 0o700)
  }

  expect(removed).toBe(false)
})

test.skipIf(process.platform === "win32")("dangling config symlink fails before logout removes credentials", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "ruying-code.jsonc")
  await symlink(path.join(tmp.path, "missing-target.jsonc"), file)
  let removed = false

  await expect(
    Effect.runPromise(
      logoutRuying({
        prepareIdentity: () => prepareRuyingIdentityRemoval(file),
        get: () => Effect.succeed({ type: "api" as const, key: "secret" }),
        remove: () => Effect.sync(() => (removed = true)),
        set: () => Effect.void,
      }),
    ),
  ).rejects.toMatchObject({ _tag: "RuyingSessionLogoutError" })
  expect(removed).toBe(false)
})

test.skipIf(process.platform === "win32")("config publication failure restores the removed credential", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "ruying-code.jsonc")
  const credential = { type: "api" as const, key: "secret", metadata: { employeeId: "GW001" } }
  await Bun.write(file, '{ "provider": { "ruying": { "options": { "ruyingUser": {} } } } }')
  let restored: typeof credential | undefined
  let removed = false
  await chmod(tmp.path, 0o500)

  try {
    await expect(
      Effect.runPromise(
        logoutRuying({
          prepareIdentity: () => prepareRuyingIdentityRemoval(file),
          get: () => Effect.succeed(credential),
          remove: () => Effect.sync(() => (removed = true)),
          set: (_providerID, info) => Effect.sync(() => (restored = info as typeof credential)),
        }),
      ),
    ).rejects.toMatchObject({ _tag: "RuyingSessionLogoutError" })
  } finally {
    await chmod(tmp.path, 0o700)
  }

  expect(removed).toBe(true)
  expect(restored).toEqual(credential)
  expect(parse(await Bun.file(file).text()).provider.ruying.options.ruyingUser).toEqual({})
})

test.each(["auto", "code"] as const)("%s OAuth failure is a CLI failure", async (method) => {
  await expect(Effect.runPromise(requirePluginAuthSuccess({ type: "failed" }, method))).rejects.toMatchObject({
    _tag: "CliError",
    exitCode: 1,
  })
})
