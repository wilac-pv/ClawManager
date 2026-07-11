import { expect, test } from "bun:test"
import { debugArchiveName, serverLogRoots } from "./logging-paths"

test("brands debug archives and includes current plus legacy server logs", () => {
  expect(debugArchiveName("20260711T120000")).toBe("ruying-code-debug-20260711T120000.zip")
  expect(serverLogRoots({ xdgData: "/xdg/data", userData: "/desktop/data" })).toEqual([
    "/xdg/data/ruying-code/log",
    "/xdg/data/opencode/log",
    "/desktop/data/ruying-code/log",
    "/desktop/data/opencode/log",
  ])
})
