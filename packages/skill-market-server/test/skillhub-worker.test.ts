import { expect, test } from "bun:test"
import { runSkillHubWorker } from "../src/skillhub-worker"

test("compatibility worker runs the full synchronization exactly once", async () => {
  const calls: string[] = []

  await runSkillHubWorker(async () => {
    calls.push("sync")
  })

  expect(calls).toEqual(["sync"])
})
