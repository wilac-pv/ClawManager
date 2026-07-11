import { expect, test } from "bun:test"
import { requireRuyingLogin } from "@/auth/ruying-gate"
import { getRuyingSessionStatus } from "@/auth/ruying-session"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Effect, Layer } from "effect"

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
  await expect(run({ type: "api", key: "sk" }, {})).resolves.toBeUndefined()
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
