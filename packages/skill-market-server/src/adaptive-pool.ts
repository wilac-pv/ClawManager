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
  let recoveryAt: number | undefined
  const successfulLatencies: number[] = []
  let timeouts = 0

  const recover = () => {
    if (recoveryAt === undefined || p95(successfulLatencies) > 1_000 || now() < recoveryAt) return limit
    const increments = Math.min(options.maximum - limit, Math.floor((now() - recoveryAt) / 60_000) + 1)
    limit += increments
    recoveryAt += increments * 60_000
    return limit
  }

  const throttle = () => {
    limit = Math.max(options.minimum, Math.ceil(limit / 2))
    recoveryAt = now() + 5 * 60_000
    successfulLatencies.splice(0)
  }

  const runWithRetries = async <Output>(run: () => Promise<Output>) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const startedAt = now()
        const value = await run()
        if (value instanceof Response && !value.ok)
          throw new AdaptivePoolError(
            `SkillHub request failed with ${value.status}`,
            value.status,
            value.headers.get("retry-after"),
            value.status < 500 && value.status !== 429,
          )
        timeouts = 0
        // A successful request is stable when the rolling p95 stays within one second.
        successfulLatencies.push(now() - startedAt)
        if (successfulLatencies.length > 20) successfulLatencies.shift()
        return value
      } catch (error) {
        if (!retryable(error)) throw error
        const isTimeout = error instanceof AdaptivePoolError && error.status === undefined
        timeouts = isTimeout ? timeouts + 1 : 0
        if ((error instanceof AdaptivePoolError && error.status === 429) || timeouts >= 2) throttle()
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
  return (
    error instanceof AdaptivePoolError &&
    !error.permanent &&
    (error.status === undefined || error.status === 429 || error.status >= 500)
  )
}

function retryDelay(error: unknown, attempt: number, timestamp: number) {
  const retryAfter = error instanceof AdaptivePoolError ? parseRetryAfter(error.retryAfter, timestamp) : undefined
  return retryAfter ?? Math.min(30_000, 1_000 * 2 ** attempt)
}

function p95(values: readonly number[]) {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.ceil(ordered.length * 0.95) - 1]!
}

function parseRetryAfter(input: string | null | undefined, timestamp: number) {
  if (!input) return undefined
  if (/^\d+$/.test(input)) return Number(input) * 1_000
  const date = Date.parse(input)
  return Number.isNaN(date) ? undefined : Math.max(0, date - timestamp)
}
