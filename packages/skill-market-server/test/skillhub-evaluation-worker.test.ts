import { describe, expect, test } from "bun:test"
import { loadConfig } from "../src/config"
import { evaluationPublication, runSkillHubEvaluationWorker } from "../src/skillhub-evaluation-worker"
import type { SkillHubEvaluation } from "../src/skillhub-evaluation"
import type { SkillHubImportStore } from "../src/skillhub-import-store"
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
  test("rejects a publication batch larger than one hundred", async () => {
    await expect(
      runSkillHubEvaluationWorker({
        workerID: "evaluation-test",
        evaluations: createQueue({ value: 0 }, []),
        publicationBatch: 101,
        loadEvaluation: async () => evaluation,
      }),
    ).rejects.toThrow("SkillHub evaluation publication batch must be between 1 and 100")
  })

  test("routes completed evaluation publication through the delta publisher", async () => {
    let calls = 0
    const imports: Pick<SkillHubImportStore, "completedEvaluations" | "progress" | "replaceCompletedEvaluationDetails"> = {
      completedEvaluations: () => [],
      progress: () => ({ sourceStatus: "fresh" } as ReturnType<SkillHubImportStore["progress"]>),
      replaceCompletedEvaluationDetails: () => [],
    }
    const publication = evaluationPublication(
      imports,
      {
        async publishCompletedSkillHubEvaluations(_imports, workerID, batch, signal) {
          calls += 1
          expect(workerID).toBe("evaluation-test")
          expect(batch).toBe(100)
          expect(signal?.aborted).toBe(false)
          return { revision: undefined, mirrored: 0 }
        },
      },
      "evaluation-test",
      100,
    )

    await publication.publish({ signal: new AbortController().signal, deadline: 1_000 })

    expect(calls).toBe(1)
  })

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

  test("does not start a reserved request when its rate-limit slot is at the runtime deadline", async () => {
    const clock = { value: 0 }
    const queue = createQueue(clock, ["first", "second"])
    const starts: string[] = []
    const result = await runSkillHubEvaluationWorker({
      workerID: "evaluation-test",
      evaluations: queue,
      concurrency: 2,
      durationMilliseconds: 1_000,
      now: () => clock.value,
      wait: async (milliseconds) => {
        await Promise.resolve()
        clock.value += milliseconds
      },
      loadEvaluation: async (slug) => {
        starts.push(slug)
        return evaluation
      },
    })

    expect(starts).toEqual(["first"])
    expect(result).toMatchObject({ completed: 1, retryWait: 1 })
    expect(queue.retrying).toEqual(["second"])
  })

  test("aborts a hung evaluation at the runtime deadline and returns its lease to retry state", async () => {
    const clock = { value: 0 }
    const queue = createQueue(clock, ["hung"])
    const timers = createTimers(clock)
    const heartbeats = createIntervals()
    let signal: AbortSignal | undefined
    const run = runSkillHubEvaluationWorker({
      workerID: "evaluation-test",
      evaluations: queue,
      durationMilliseconds: 1_000,
      now: () => clock.value,
      wait: async () => undefined,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: heartbeats.setInterval,
      clearInterval: heartbeats.clearInterval,
      loadEvaluation: async (_slug, request?: { readonly signal: AbortSignal }) => {
        signal = request?.signal
        return new Promise<SkillHubEvaluation>(() => undefined)
      },
    })

    await waitFor(() => signal !== undefined)
    clock.value = 1_000
    timers.runDue()

    expect(signal?.aborted).toBe(true)
    expect(await run).toMatchObject({ completed: 0, retryWait: 1 })
    expect(queue.retrying).toEqual(["hung"])
    expect(heartbeats.cleared).toBe(1)
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

  test("passes a deadline-bound abort signal to a due publication", async () => {
    const result = await runSkillHubEvaluationWorker({
      workerID: "evaluation-test",
      evaluations: createQueue({ value: 0 }, []),
      durationMilliseconds: 1_000,
      now: () => 0,
      wait: async () => undefined,
      publication: {
        pending: () => ({ count: 1, oldestCheckedAt: 0 }),
        publish: async (request) => {
          expect(request.signal.aborted).toBe(false)
        },
      },
      publicationBatch: 1,
      loadEvaluation: async () => evaluation,
    })

    expect(result).toMatchObject({ published: 1, publicationFailures: 0 })
  })

  test("stops a deadline-cancelled publication before the caller can close its database", async () => {
    const clock = { value: 0 }
    const timers = createTimers(clock)
    let signal: AbortSignal | undefined
    let stopped = false
    let pointerMutations = 0
    let markerMutations = 0
    let closed = false
    const run = runSkillHubEvaluationWorker({
      workerID: "evaluation-test",
      evaluations: createQueue(clock, []),
      durationMilliseconds: 1_000,
      now: () => clock.value,
      wait: async () => undefined,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      publication: {
        pending: () => ({ count: 1, oldestCheckedAt: 0 }),
        publish: async (request) => {
          signal = request.signal
          await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => {
            stopped = true
            resolve()
          }, { once: true }))
          if (!request.signal.aborted) pointerMutations += 1
          if (!request.signal.aborted) markerMutations += 1
        },
      },
      publicationBatch: 1,
      loadEvaluation: async () => evaluation,
    }).finally(() => {
      expect(stopped).toBe(true)
      closed = true
    })

    await waitFor(() => signal !== undefined)
    clock.value = 1_000
    timers.runDue()

    expect(await run).toMatchObject({ published: 0, publicationFailures: 0 })
    expect(closed).toBe(true)
    expect(pointerMutations).toBe(0)
    expect(markerMutations).toBe(0)
  })

  test("does not start a due publication at the runtime deadline", async () => {
    const clock = { value: 0 }
    let started = false
    const result = await runSkillHubEvaluationWorker({
      workerID: "evaluation-test",
      evaluations: createQueue(clock, []),
      durationMilliseconds: 1_000,
      now: () => clock.value,
      wait: async () => undefined,
      publication: {
        pending: () => {
          clock.value = 1_000
          return { count: 1, oldestCheckedAt: 0 }
        },
        publish: async () => {
          started = true
        },
      },
      publicationBatch: 1,
      loadEvaluation: async () => evaluation,
    })

    expect(result).toMatchObject({ published: 0, publicationFailures: 0 })
    expect(started).toBe(false)
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
  expect(config.skillhubEvaluationDurationMilliseconds).toBe(75_000)
})

test("rejects a TRACE evaluation publication batch larger than one hundred from the environment", () => {
  expect(() =>
    loadConfig({
      SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://enterprise.example.com/index.json",
      SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
      SKILL_MARKET_PUBLIC_BASE_URL: "https://market.example.com/public/",
      SKILL_MARKET_EVALUATION_PUBLISH_BATCH: "101",
    }),
  ).toThrow("SKILL_MARKET_EVALUATION_PUBLISH_BATCH must be a positive integer up to 100")
})

function createQueue(clock: { readonly value: number }, initial: readonly string[]) {
  const pending = [...initial]
  const retry = new Map<string, number>()
  const running = new Set<string>()
  const queue = {
    completed: [] as string[],
    retrying: [] as string[],
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
      queue.retrying.push(slug)
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

function createTimers(clock: { readonly value: number }) {
  let identifier = 0
  const timers = new Map<number, { readonly callback: () => void; readonly at: number }>()
  return {
    setTimeout: ((callback: () => void, milliseconds?: number) => {
      identifier += 1
      timers.set(identifier, { callback, at: clock.value + (milliseconds ?? 0) })
      return identifier
    }) as unknown as typeof setTimeout,
    clearTimeout: ((timer: number) => timers.delete(timer)) as unknown as typeof clearTimeout,
    runDue() {
      Array.from(timers)
        .filter(([, timer]) => timer.at <= clock.value)
        .forEach(([timer, entry]) => {
          timers.delete(timer)
          entry.callback()
        })
    },
  }
}

function createIntervals() {
  let identifier = 0
  const active = new Set<number>()
  let cleared = 0
  return {
    setInterval: ((_: () => void) => {
      identifier += 1
      active.add(identifier)
      return identifier
    }) as unknown as typeof setInterval,
    clearInterval: ((interval: number) => {
      if (active.delete(interval)) cleared += 1
    }) as unknown as typeof clearInterval,
    get cleared() {
      return cleared
    },
  }
}

async function waitFor(condition: () => boolean) {
  while (!condition()) await Promise.resolve()
}
