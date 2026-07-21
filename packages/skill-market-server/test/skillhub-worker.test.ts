import { expect, test } from "bun:test"
import {
  createSkillHubWorkerWake,
  runConfiguredSkillHubWorker,
  runSkillHubWorker,
  shouldPublishSkillHub,
} from "../src/skillhub-worker"
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

test("recovers expired catalog work before discovery can release deferred imports", async () => {
  const calls: string[] = []
  await runSkillHubWorker({
    workerID: "skillhub-restart",
    recover: async () => {
      calls.push("recover")
    },
    discover: async () => {
      calls.push("discover")
    },
    mirror: { runBatch: async () => ({ mirrored: 0, retryWait: 0, rejected: 0 }) },
    progress: () => ({ mirrored: 0 }),
    publicationCheckpoint: () => ({ lastPublishedCount: 0 }),
    shouldPublish: () => false,
    emit: () => undefined,
  })

  expect(calls).toEqual(["recover", "discover"])
})

test("publishes the initial 1-1,999 item canary after its generation has waited 30 minutes", () => {
  expect(
    shouldPublishSkillHub(
      { mirrored: 1_999, sourceStatus: "stale", pending: 1, running: 0, retryWait: 0 },
      { lastPublishedCount: 0, startedAt: "2026-07-17T00:00:00.000Z" },
      { batch: 2_000, minutes: 30, now: () => Date.parse("2026-07-17T00:30:00.000Z") },
    ),
  ).toBe(true)
})

test("does not publish fewer mirrored items than the durable publication checkpoint", () => {
  expect(
    shouldPublishSkillHub(
      { mirrored: 77_099, sourceStatus: "stale", pending: 88, running: 0, retryWait: 4 },
      {
        lastPublishedCount: 77_187,
        lastPublishedAt: "2026-07-17T00:00:00.000Z",
      },
      { batch: 2_000, minutes: 30, now: () => Date.parse("2026-07-20T00:00:00.000Z") },
    ),
  ).toBe(false)
})

test("records a publication checkpoint only after the catalog pointer publish succeeds", async () => {
  const checkpoints: number[] = []
  await runSkillHubWorker({
    workerID: "skillhub-test",
    discover: async () => undefined,
    mirror: { runBatch: async () => ({ mirrored: 1, retryWait: 0, rejected: 0 }) },
    progress: () => ({ mirrored: 1 }),
    publicationCheckpoint: () => ({ lastPublishedCount: 0 }),
    shouldPublish: () => true,
    publish: async () => undefined,
    recordPublication: (count) => checkpoints.push(count),
    durationMilliseconds: 0,
    emit: () => undefined,
  })
  expect(checkpoints).toEqual([1])

  await expect(
    runSkillHubWorker({
      workerID: "skillhub-test",
      discover: async () => undefined,
      mirror: { runBatch: async () => ({ mirrored: 1, retryWait: 0, rejected: 0 }) },
      progress: () => ({ mirrored: 1 }),
      publicationCheckpoint: () => ({ lastPublishedCount: 0 }),
      shouldPublish: () => true,
      publish: async () => Promise.reject(new Error("pointer write failed")),
      recordPublication: (count) => checkpoints.push(count),
      durationMilliseconds: 0,
      emit: () => undefined,
    }),
  ).rejects.toThrow("pointer write failed")
  expect(checkpoints).toEqual([1])
})

test("configured worker provides its catalog publisher without an injected callback", async () => {
  const config = loadConfig({
    SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://enterprise.example.com/index.json",
    SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
    SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com/public/",
  })

  await expect(runConfiguredSkillHubWorker({ config })).rejects.not.toThrow("publication callback")
})

test("coalesces SkillHub wakes, records failures, and accepts a later wake", async () => {
  let attempts = 0
  let release: () => void = () => undefined
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const metrics: Readonly<Record<string, unknown>>[] = []
  const wake = createSkillHubWorkerWake({
    run: async () => {
      attempts++
      if (attempts !== 1) return
      await blocked
      throw new Error("upstream unavailable")
    },
    emit: (metric) => metrics.push(metric),
  })

  const first = wake.wake()
  await Promise.resolve()
  const coalesced = wake.wake()
  expect(attempts).toBe(1)
  release()
  await Promise.all([first, coalesced])
  expect(attempts).toBe(2)
  expect(metrics).toContainEqual({ skill_market_skillhub_wake_result: { failure: 1 } })

  await wake.wake()
  expect(attempts).toBe(3)
})
