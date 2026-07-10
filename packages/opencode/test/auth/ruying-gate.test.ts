import { expect, test } from "bun:test"
import { requireRuyingLogin } from "@/auth/ruying-gate"

test("requires both a ruying key and sso identity metadata", async () => {
  await expect(requireRuyingLogin(undefined)).rejects.toThrow("ruying-code login")
  await expect(requireRuyingLogin({ type: "api", key: "sk", metadata: {} })).rejects.toThrow("ruying-code login")
  await expect(
    requireRuyingLogin({ type: "api", key: "sk", metadata: { employeeId: "GW001", displayName: "张三" } }),
  ).resolves.toBeUndefined()
})
