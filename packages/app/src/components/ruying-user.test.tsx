import { expect, test } from "bun:test"
import { logoutRuying, readRuyingStatusUser } from "./ruying-user"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

test("does not reload when logout fails", async () => {
  const calls: string[] = []
  const result = await logoutRuying({
    remove: async () => {
      throw new Error("disk")
    },
    reload: () => calls.push("reload"),
  })

  expect(result).toEqual({ ok: false, message: "disk" })
  expect(calls).toEqual([])
})

test("reloads only after logout succeeds", async () => {
  const removing = deferred<void>()
  const calls: string[] = []
  const logout = logoutRuying({
    remove: async () => {
      calls.push("remove:start")
      await removing.promise
      calls.push("remove:end")
    },
    reload: () => calls.push("reload"),
  })

  await Promise.resolve()
  expect(calls).toEqual(["remove:start"])
  removing.resolve()
  expect(await logout).toEqual({ ok: true })
  expect(calls).toEqual(["remove:start", "remove:end", "reload"])
})

test("reads identity only from authoritative logged-in status", () => {
  expect(
    readRuyingStatusUser({
      data: { loggedIn: true, user: { employeeId: "GW001", displayName: "张三", email: "zhang@example.com" } },
    }),
  ).toEqual({ employeeId: "GW001", displayName: "张三", email: "zhang@example.com" })
  expect(readRuyingStatusUser({ data: { loggedIn: false } })).toBeUndefined()
  expect(readRuyingStatusUser({ error: new Error("offline") })).toBeUndefined()
})

test("public layouts do not expose generic provider connection controls", async () => {
  const layouts = await Promise.all(
    ["../pages/layout.tsx", "../pages/layout-new.tsx"].map((path) => Bun.file(new URL(path, import.meta.url)).text()),
  )

  for (const source of layouts) {
    expect(source).not.toContain('id: "provider.connect"')
    expect(source).not.toContain("dialog-connect-provider")
    expect(source).not.toContain("command.provider.connect")
  }
})
