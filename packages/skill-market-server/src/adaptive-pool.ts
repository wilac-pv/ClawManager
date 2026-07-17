export interface AdaptivePool {
  readonly concurrency: () => number
  readonly map: <Input, Output>(
    values: readonly Input[],
    run: (value: Input) => Promise<Output>,
  ) => Promise<Output[]>
}

export interface AdaptivePoolOptions {
  readonly minimum: number
  readonly maximum: number
  readonly now?: () => number
  readonly wait?: (milliseconds: number) => Promise<void>
}

export class AdaptivePoolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null,
    readonly permanent = false,
  ) {
    super(message)
  }
}

export function createAdaptivePool(options: AdaptivePoolOptions): AdaptivePool {
  if (!Number.isInteger(options.minimum) || !Number.isInteger(options.maximum) || options.minimum < 1 || options.minimum > options.maximum)
    throw new Error("Adaptive pool limits must be positive integers")
  const now = options.now ?? Date.now
  const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let limit = options.maximum
  let throttledAt: number | undefined
  let successfulSinceThrottle = false
  let timeouts = 0

  const recover = () => {
    if (
      throttledAt !== undefined &&
      successfulSinceThrottle &&
      now() - throttledAt >= 5 * 60_000 &&
      limit < options.maximum
    ) {
      limit += 1
      throttledAt = now()
    }
    return limit
  }

  const throttle = () => {
    limit = Math.max(options.minimum, Math.ceil(limit / 2))
    throttledAt = now()
    successfulSinceThrottle = false
  }

  const runWithRetries = async <Output>(run: () => Promise<Output>) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const value = await run()
        if (value instanceof Response && !value.ok)
          throw new AdaptivePoolError(
            `SkillHub request failed with ${value.status}`,
            value.status,
            value.headers.get("retry-after"),
            value.status < 500 && value.status !== 429,
          )
        timeouts = 0
        successfulSinceThrottle = true
        return value
      } catch (error) {
        if (!retryable(error)) throw error
        const isTimeout = !requestError(error)
        timeouts = isTimeout ? timeouts + 1 : 0
        if ((requestError(error) && error.status === 429) || timeouts >= 2) throttle()
        if (attempt >= 2) throw error
        await wait(retryDelay(error, attempt, now()))
      }
    }
  }

  return {
    concurrency: recover,
    map<Input, Output>(values: readonly Input[], run: (value: Input) => Promise<Output>) {
      if (values.length === 0) return Promise.resolve([])
      return new Promise<Output[]>((resolve, reject) => {
        const output: Output[] = Array(values.length)
        let active = 0
        let cursor = 0
        let completed = 0
        let failure: unknown

        const schedule = () => {
          const current = recover()
          while (!failure && active < current && cursor < values.length) {
            const index = cursor
            cursor += 1
            active += 1
            runWithRetries(() => run(values[index]!)).then(
              (value) => {
                output[index] = value
                completed += 1
              },
              (error) => {
                failure = error
              },
            ).finally(() => {
              active -= 1
              if (active !== 0) return schedule()
              if (failure) return reject(failure)
              if (completed === values.length) return resolve(output)
              schedule()
            })
          }
        }
        schedule()
      })
    },
  }
}

function retryable(error: unknown) {
  if (requestError(error)) return !error.permanent && (error.status === 429 || (error.status ?? 0) >= 500)
  return networkFailure(error)
}

function retryDelay(error: unknown, attempt: number, timestamp: number) {
  const retryAfter = requestError(error) ? parseRetryAfter(error.retryAfter, timestamp) : undefined
  return retryAfter ?? Math.min(30_000, 1_000 * 2 ** attempt)
}

function requestError(error: unknown): error is {
  readonly status?: number
  readonly retryAfter?: string | null
  readonly permanent: boolean
} {
  return (
    typeof error === "object" &&
    error !== null &&
    "permanent" in error &&
    typeof error.permanent === "boolean" &&
    (!("status" in error) || error.status === undefined || typeof error.status === "number") &&
    (!("retryAfter" in error) || error.retryAfter === undefined || error.retryAfter === null || typeof error.retryAfter === "string")
  )
}

function networkFailure(error: unknown) {
  if (error instanceof TypeError) return true
  return error instanceof Error && /\b(timeout|timed out|network|fetch failed|socket|econn)\b/i.test(error.message)
}

function parseRetryAfter(input: string | null | undefined, timestamp: number) {
  if (!input) return undefined
  if (/^\d+$/.test(input)) return Number(input) * 1_000
  const date = Date.parse(input)
  return Number.isNaN(date) ? undefined : Math.max(0, date - timestamp)
}
