import { expect, test } from "bun:test"
import { isRuyingLoggedIn } from "../../src/component/ruying-login"

test("blocks children until ruying identity exists", () => {
  expect(isRuyingLoggedIn(undefined)).toBe(false)
  expect(isRuyingLoggedIn({ apiKey: "sk-existing" })).toBe(false)
})

test("accepts a logged-in ruying user", () => {
  expect(isRuyingLoggedIn({ ruyingUser: { employeeId: "GW001", displayName: "张三" } })).toBe(true)
})
