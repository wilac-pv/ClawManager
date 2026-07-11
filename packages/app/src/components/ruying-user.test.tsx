import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRuyingUserController, logoutRuying, readRuyingStatusUser } from "./ruying-user"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
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

test("public app surfaces do not register generic provider controls", async () => {
  const root = new URL("..", import.meta.url)
  const internal = new Set([
    "components/dialog-connect-provider.tsx",
    "components/dialog-custom-provider.tsx",
    "components/settings-providers.tsx",
    "components/settings-v2/providers.tsx",
  ])
  const forbidden = [
    "dialog-connect-provider",
    "dialog-custom-provider",
    "DialogConnectProvider",
    "DialogCustomProvider",
    "SettingsProviders",
    "useProviderConnectController",
    "command.provider.connect",
  ]

  for await (const path of new Bun.Glob("**/*.tsx").scan({ cwd: root.pathname })) {
    if (path.endsWith(".test.tsx") || internal.has(path)) continue
    const source = await Bun.file(new URL(path, root)).text()
    forbidden.forEach((token) => expect(source, `${path} exposes ${token}`).not.toContain(token))
  }
})

test("status failure is explicit and retryable", async () => {
  const first = deferred<{ error?: unknown; data?: { loggedIn: boolean; user?: unknown } }>()
  let status = () => first.promise
  const runtime = {
    status: () => status(),
    logout: async () => undefined,
    subscribe: () => () => undefined,
  }

  await new Promise<void>((resolve) =>
    createRoot((dispose) => {
      const user = createRuyingUserController({ runtime: () => runtime, reload: () => undefined })
      expect(user.state.status).toBe("checking")
      first.resolve({ error: new Error("offline") })
      void first.promise.then(async () => {
        await Promise.resolve()
        expect(user.state.status).toBe("error")
        expect(user.state.message).toContain("offline")

        status = async () => ({
          data: { loggedIn: true, user: { employeeId: "GW001", displayName: "张三", email: "" } },
        })
        await user.refresh()
        expect(user.state.status).toBe("user")
        expect(user.state.user?.employeeId).toBe("GW001")
        dispose()
        resolve()
      })
    }),
  )
})

test("newer status response wins over stale overlap", async () => {
  const first = deferred<{ data: { loggedIn: boolean; user?: unknown } }>()
  const second = deferred<{ data: { loggedIn: boolean; user?: unknown } }>()
  let calls = 0
  const runtime = {
    status: () => (++calls === 1 ? first.promise : second.promise),
    logout: async () => undefined,
    subscribe: () => () => undefined,
  }

  await new Promise<void>((resolve) =>
    createRoot((dispose) => {
      const user = createRuyingUserController({ runtime: () => runtime, reload: () => undefined })
      const latest = user.refresh()
      second.resolve({ data: { loggedIn: true, user: { employeeId: "NEW", displayName: "新", email: "" } } })
      void latest.then(async () => {
        first.resolve({ data: { loggedIn: true, user: { employeeId: "OLD", displayName: "旧", email: "" } } })
        await first.promise
        await Promise.resolve()
        expect(user.state.user?.employeeId).toBe("NEW")
        dispose()
        resolve()
      })
    }),
  )
})

test("refreshes on lifecycle events and replaces sdk listener reactively", async () => {
  const listeners = new Map<string, (event: { type: string }) => void>()
  const removed: string[] = []
  const calls: string[] = []
  const makeRuntime = (id: string) => ({
    status: async () => {
      calls.push(id)
      return { data: { loggedIn: false } }
    },
    logout: async () => undefined,
    subscribe: (listener: (event: { type: string }) => void) => {
      listeners.set(id, listener)
      return () => {
        removed.push(id)
        listeners.delete(id)
      }
    },
  })

  await new Promise<void>((resolve) =>
    createRoot((dispose) => {
      const first = makeRuntime("first")
      const user = createRuyingUserController({ runtime: () => first, reload: () => undefined })
      queueMicrotask(async () => {
        listeners.get("first")?.({ type: "server.connected" })
        await Promise.resolve()
        expect(calls.filter((id) => id === "first")).toHaveLength(2)

        const stop = user.activate(makeRuntime("second"))
        await Promise.resolve()
        expect(removed).toEqual(["first"])
        expect(listeners.has("second")).toBe(true)
        listeners.get("second")?.({ type: "global.disposed" })
        await Promise.resolve()
        expect(calls.filter((id) => id === "second")).toHaveLength(2)

        stop()
        expect(removed).toEqual(["first", "second"])
        dispose()
        resolve()
      })
    }),
  )
})

test("successful logout clears identity before reload", async () => {
  const calls: string[] = []
  const runtime = {
    status: async () => ({
      data: { loggedIn: true, user: { employeeId: "GW001", displayName: "张三", email: "" } },
    }),
    logout: async () => {
      calls.push("logout")
    },
    subscribe: () => () => undefined,
  }

  await new Promise<void>((resolve) =>
    createRoot((dispose) => {
      const user = createRuyingUserController({
        runtime: () => runtime,
        reload: () => calls.push(`reload:${user.state.status}`),
      })
      queueMicrotask(async () => {
        await user.logout()
        expect(calls).toEqual(["logout", "reload:loggedOut"])
        expect(user.state.user).toBeUndefined()
        dispose()
        resolve()
      })
    }),
  )
})

test("failed logout keeps identity and action retryable", async () => {
  let attempts = 0
  const runtime = {
    status: async () => ({
      data: { loggedIn: true, user: { employeeId: "GW001", displayName: "张三", email: "" } },
    }),
    logout: async () => {
      attempts++
      throw new Error("disk")
    },
    subscribe: () => () => undefined,
  }

  await new Promise<void>((resolve) =>
    createRoot((dispose) => {
      const user = createRuyingUserController({ runtime: () => runtime, reload: () => undefined })
      queueMicrotask(async () => {
        await user.logout()
        expect(user.state.status).toBe("user")
        expect(user.state.user?.employeeId).toBe("GW001")
        expect(user.state.loggingOut).toBe(false)
        expect(user.state.logoutMessage).toBe("disk")
        await user.logout()
        expect(attempts).toBe(2)
        dispose()
        resolve()
      })
    }),
  )
})

test("lifecycle refresh during failed logout still restores the action", async () => {
  const attempt = deferred<void>()
  let listener: ((event: { type: string }) => void) | undefined
  const runtime = {
    status: async () => ({
      data: { loggedIn: true, user: { employeeId: "GW001", displayName: "张三", email: "" } },
    }),
    logout: () => attempt.promise,
    subscribe: (next: (event: { type: string }) => void) => {
      listener = next
      return () => undefined
    },
  }

  await new Promise<void>((resolve) =>
    createRoot((dispose) => {
      const user = createRuyingUserController({ runtime: () => runtime, reload: () => undefined })
      queueMicrotask(async () => {
        const logout = user.logout()
        listener?.({ type: "server.connected" })
        await Promise.resolve()
        attempt.reject(new Error("disk"))
        await logout
        expect(user.state.status).toBe("user")
        expect(user.state.loggingOut).toBe(false)
        expect(user.state.logoutMessage).toBe("disk")
        dispose()
        resolve()
      })
    }),
  )
})

test("late pre-logout status cannot restore identity after successful logout", async () => {
  const status = deferred<{ data: { loggedIn: boolean; user?: unknown } }>()
  const runtime = {
    status: () => status.promise,
    logout: async () => undefined,
    subscribe: () => () => undefined,
  }

  await new Promise<void>((resolve) =>
    createRoot((dispose) => {
      const user = createRuyingUserController({ runtime: () => runtime, reload: () => undefined })
      queueMicrotask(async () => {
        await user.logout()
        expect(user.state.status).toBe("loggedOut")
        status.resolve({
          data: { loggedIn: true, user: { employeeId: "STALE", displayName: "旧", email: "" } },
        })
        await status.promise
        await Promise.resolve()
        expect(user.state.status).toBe("loggedOut")
        expect(user.state.user).toBeUndefined()
        dispose()
        resolve()
      })
    }),
  )
})

test("status started during logout cannot restore identity after logout succeeds", async () => {
  const logout = deferred<void>()
  const refresh = deferred<{ data: { loggedIn: boolean; user?: unknown } }>()
  let statuses = 0
  let listener: ((event: { type: string }) => void) | undefined
  const runtime = {
    status: async () => {
      statuses++
      if (statuses === 1) {
        return { data: { loggedIn: true, user: { employeeId: "GW001", displayName: "张三", email: "" } } }
      }
      return refresh.promise
    },
    logout: () => logout.promise,
    subscribe: (next: (event: { type: string }) => void) => {
      listener = next
      return () => undefined
    },
  }

  await new Promise<void>((resolve) =>
    createRoot((dispose) => {
      const user = createRuyingUserController({ runtime: () => runtime, reload: () => undefined })
      queueMicrotask(async () => {
        const loggingOut = user.logout()
        listener?.({ type: "global.disposed" })
        await Promise.resolve()
        logout.resolve()
        await loggingOut
        expect(user.state.status).toBe("loggedOut")

        refresh.resolve({
          data: { loggedIn: true, user: { employeeId: "STALE", displayName: "旧", email: "" } },
        })
        await refresh.promise
        await Promise.resolve()
        expect(user.state.status).toBe("loggedOut")
        expect(user.state.user).toBeUndefined()
        dispose()
        resolve()
      })
    }),
  )
})
