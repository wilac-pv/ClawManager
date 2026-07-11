import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("如影 Code")
  expect(epilogue).toContain("ruying-code -s ses_123")
  expect(epilogue).not.toContain("opencode -s")
})
