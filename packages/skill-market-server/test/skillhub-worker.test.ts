import { expect, test } from "bun:test"
import { runConfiguredSkillHubWorker, runSkillHubWorker } from "../src/skillhub-worker"
import { loadConfig } from "../src/config"

test("runs bounded discovery and only publishes when its due callback permits it", async () => {
  const calls: string[] = []
  const result = await runSkillHubWorker({
    workerID: "skillhub-test",
    durationMilliseconds: 50_000,
    now: (() => {
      let now = 0
      return () => now++
    })(),
    discover: async () => {
      calls.push("discover")
    },
    mirror: {
      runBatch: async () => {
        calls.push("mirror")
        return calls.filter((value) => value === "mirror").length === 1
          ? { mirrored: 1, retryWait: 0, rejected: 0 }
          : { mirrored: 0, retryWait: 0, rejected: 0 }
      },
    },
    progress: () => ({ mirrored: 1 }),
    publicationCheckpoint: () => ({ lastPublishedCount: 0 }),
    shouldPublish: () => true,
    emit: () => undefined,
    publish: async () => {
      calls.push("publish")
    },
  })

  expect(result).toEqual({ mirrored: 1, retryWait: 0, rejected: 0, published: true })
  expect(calls).toEqual(["discover", "mirror", "mirror", "publish"])
})

test("does not call an unavailable publisher boundary", async () => {
  let published = false
  const result = await runSkillHubWorker({
    workerID: "skillhub-test",
    discover: async () => undefined,
    mirror: { runBatch: async () => ({ mirrored: 0, retryWait: 0, rejected: 0 }) },
    progress: () => ({ mirrored: 0 }),
    publicationCheckpoint: () => ({ lastPublishedCount: 0 }),
    shouldPublish: () => false,
    emit: () => undefined,
    publish: async () => {
      published = true
    },
  })

  expect(result.published).toBe(false)
  expect(published).toBe(false)
})

test("configured worker fails closed before opening resources without a publisher", async () => {
  const config = loadConfig({
    SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://enterprise.example.com/index.json",
    SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
    SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com/public/",
  })

  await expect(runConfiguredSkillHubWorker({ config })).rejects.toThrow("publication callback")
})
