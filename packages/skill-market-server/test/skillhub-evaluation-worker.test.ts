import { describe, expect, test } from "bun:test"
import { loadConfig } from "../src/config"
import { runSkillHubEvaluationWorker } from "../src/skillhub-evaluation-worker"
import type { SkillHubEvaluation } from "../src/skillhub-evaluation"
import { SkillHubRequestError } from "../src/skillhub"

const evaluation = {
  trust: 5,
  reliability: 4,
  adaptability: 4.3,
  convention: 4.325,
  effectiveness: 4.625,
  score: 4.45,
} as const satisfies SkillHubEvaluation

describe("SkillHub evaluation worker", () => {
  test("uses one shared request schedule while two evaluations are active", async () => {
    const clock = { value: 0 }
    const queue = createQueue(clock, ["a", "b", "c"])
    const starts: number[] = []
    const releases = new Map<string, () => void>()
    let active = 0
    let maximum = 0
    const run = runSkillHubEvaluationWorker({
      workerID: "evaluation-test",
      evaluations: queue,
      durationMilliseconds: 5_000,
      now: () => clock.value,
      wait: async (milliseconds) => {
        await Promise.resolve()
        clock.value += milliseconds
      },
      loadEvaluation: (slug) => {
        starts.push(clock.value)
        active += 1
        maximum = Math.max(maximum, active)
        return new Promise<SkillHubEvaluation>((resolve) => {
          releases.set(slug, () => {
            active -= 1
            resolve(evaluation)
          })
        })
      },
    })

    await waitFor(() => starts.length === 2)
    expect(starts).toEqual([0, 1_000])
    expect(maximum).toBe(2)
    releases.get("a")!()
    releases.get("b")!()
    await waitFor(() => releases.has("c"))
    releases.get("c")!()

    expect(await run).toMatchObject({ completed: 3, retryWait: 0, failed: 0 })
    expect(starts).toEqual([0, 1_000, 2_000])
    expect(queue.completed).toEqual(["a", "b", "c"])
  })

  test("isolates failures and resumes the retryable durable item on a later run", async () => {
    const clock = { value: 0 }
    const queue = createQueue(clock, ["bad", "good"])
    const first = await runSkillHubEvaluationWorker({
      workerID: "evaluation-test",
      evaluations: queue,
      durationMilliseconds: 5_000,
      now: () => clock.value,
      wait: async (milliseconds) => {
        clock.value += milliseconds
      },
      loadEvaluation: async (slug) => {
        if (slug === "bad") throw new Error("upstream unavailable")
        return evaluation
      },
    })

    expect(first).toMatchObject({ completed: 1, retryWait: 1, failed: 0 })
    expect(queue.completed).toEqual(["good"])
    clock.value += 1_000

    const second = await runSkillHubEvaluationWorker({
      workerID: "evaluation-restart",
      evaluations: queue,
      durationMilliseconds: 5_000,
      now: () => clock.value,
      wait: async (milliseconds) => {
        clock.value += milliseconds
      },
      loadEvaluation: async () => evaluation,
    })

    expect(second).toMatchObject({ completed: 1, retryWait: 0, failed: 0 })
    expect(queue.completed).toEqual(["good", "bad"])
  })

  test("publishes durable completed evaluations at the configured batch boundary", async () => {
    const queue = createQueue({ value: 0 }, ["a", "b"])
    let published = 0
    await runSkillHubEvaluationWorker({
      workerID: "evaluation-test",
      evaluations: queue,
      durationMilliseconds: 5_000,
      now: () => 0,
      wait: async () => undefined,
      publication: {
        pending: () => ({ count: queue.unpublished, oldestCheckedAt: 0 }),
        publish: async () => {
          published += 1
          queue.unpublished = 0
        },
      },
      publicationBatch: 2,
      loadEvaluation: async () => evaluation,
    })

    expect(published).toBe(1)
  })

  test("marks a permanent TRACE response failure terminal without stopping the batch", async () => {
    const queue = createQueue({ value: 0 }, ["invalid", "good"])
    const result = await runSkillHubEvaluationWorker({
      workerID: "evaluation-test",
      evaluations: queue,
      durationMilliseconds: 5_000,
      now: () => 0,
      wait: async () => undefined,
      loadEvaluation: async (slug) => {
        if (slug === "invalid") throw new SkillHubRequestError("invalid", undefined, undefined, true)
        return evaluation
      },
    })

    expect(result).toMatchObject({ completed: 1, retryWait: 0, failed: 1 })
    expect(queue.retryPolicies).toEqual([{ maximumAttempts: 1 }])
  })

  test("publishes an unmaterialized durable result after thirty minutes", async () => {
    let published = 0
    await runSkillHubEvaluationWorker({
      workerID: "evaluation-test",
      evaluations: createQueue({ value: 0 }, []),
      durationMilliseconds: 5_000,
      now: () => 30 * 60 * 1_000,
      wait: async () => undefined,
      publication: {
        pending: () => ({ count: 1, oldestCheckedAt: 0 }),
        publish: async () => {
          published += 1
        },
      },
      loadEvaluation: async () => evaluation,
    })

    expect(published).toBe(1)
  })
})

test("reads bounded TRACE evaluation defaults", () => {
  const config = loadConfig({
    SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://enterprise.example.com/index.json",
    SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
    SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com/public/",
  })

  expect(config.skillhubEvaluationConcurrency).toBe(2)
  expect(config.skillhubEvaluationRequestsPerMinute).toBe(60)
  expect(config.skillhubEvaluationRefreshDays).toBe(7)
  expect(config.skillhubEvaluationPublishBatch).toBe(100)
  expect(config.skillhubEvaluationPublishMinutes).toBe(30)
  expect(config.skillhubEvaluationDurationMilliseconds).toBe(50_000)
})

function createQueue(clock: { readonly value: number }, initial: readonly string[]) {
  const pending = [...initial]
  const retry = new Map<string, number>()
  const running = new Set<string>()
  const queue = {
    completed: [] as string[],
    retryPolicies: [] as Array<{ readonly maximumAttempts?: number } | undefined>,
    unpublished: 0,
    claim(_workerID: string, limit: number) {
      const ready = pending.splice(0, limit)
      const retried = Array.from(retry)
        .filter(([, at]) => at <= clock.value)
        .slice(0, Math.max(0, limit - ready.length))
        .map(([slug]) => slug)
      retried.forEach((slug) => retry.delete(slug))
      const claimed = [...ready, ...retried]
      claimed.forEach((slug) => running.add(slug))
      return claimed.map((slug) => ({ slug, attempts: 1 }))
    },
    renew(_workerID: string, slug: string) {
      return running.has(slug)
    },
    complete(_workerID: string, slug: string) {
      if (!running.delete(slug)) return false
      queue.completed.push(slug)
      queue.unpublished += 1
      return true
    },
    retry(_workerID: string, slug: string, _summary: string, policy?: { readonly maximumAttempts?: number }) {
      if (!running.delete(slug)) return false
      queue.retryPolicies.push(policy)
      if (policy?.maximumAttempts === 1) return true
      retry.set(slug, clock.value + 1_000)
      return true
    },
    markDue() {
      return 0
    },
  }
  return queue
}

async function waitFor(condition: () => boolean) {
  while (!condition()) await Promise.resolve()
}
