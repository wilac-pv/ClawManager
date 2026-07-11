import { expect, test } from "bun:test"
import { readRuyingUser } from "./ruying-login"

test("requires identity metadata instead of a bare api key", () => {
  expect(readRuyingUser({ apiKey: "sk-existing" })).toBeUndefined()
  expect(readRuyingUser({ ruyingUser: { employeeId: "GW001", displayName: "张三", email: "" } })).toEqual({
    employeeId: "GW001",
    displayName: "张三",
    email: "",
  })
})
