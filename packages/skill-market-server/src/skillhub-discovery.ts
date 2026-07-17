import { createAdaptivePool } from "./adaptive-pool"
import type { SkillHubImportStore } from "./skillhub-import-store"
import { loadSkillHubPage, type Fetcher } from "./skillhub"

export interface SkillHubDiscoveryOptions {
  readonly fetcher: Fetcher
  readonly baseUrl: string
  readonly imports: SkillHubImportStore
  readonly pageConcurrency?: number
  readonly maxPageBatches?: number
  readonly limit?: number
  readonly refresh?: boolean
  readonly now?: () => number
  readonly wait?: (milliseconds: number) => Promise<void>
}

export interface SkillHubDiscoveryResult {
  readonly discovered: number
  readonly completed: boolean
  readonly stale: boolean
  readonly pageConcurrency: number
}

export async function discoverSkillHub(options: SkillHubDiscoveryOptions): Promise<SkillHubDiscoveryResult> {
  const checkpoint = options.imports.generationCheckpoint()
  const completed = options.imports.progress().state === "completed"
  if (checkpoint?.discoveryCompleted)
    return result(options.imports, true, false, options.pageConcurrency ?? 4)
  if (checkpoint?.state === "paused") return result(options.imports, false, false, options.pageConcurrency ?? 4)
  if (!options.refresh && completed)
    return result(options.imports, true, false, options.pageConcurrency ?? 4)

  const pool = createAdaptivePool({
    minimum: 1,
    maximum: options.pageConcurrency ?? 4,
    now: options.now,
    wait: options.wait,
  })
  const [first] = await pool.map([1], (page) => loadSkillHubPage(options.fetcher, options.baseUrl, page))
  let pageBatches = 0
  let upstreamTotal = effectiveTotal(first.data.total, options.limit)
  if (completed && upstreamTotal === options.imports.progress().upstreamTotal)
    return result(options.imports, true, false, pool.concurrency())
  if (checkpoint && checkpoint.discoveryPage > 0) upstreamTotal = Math.max(checkpoint.upstreamTotal, upstreamTotal)
  const generation = options.imports.beginGeneration(upstreamTotal)
  const active = options.imports.activeGeneration()
  if (!active) return result(options.imports, true, false, options.pageConcurrency ?? 4)
  options.imports.recordPage(generation.id, 1, first.data.skills.slice(0, upstreamTotal), upstreamTotal)

  for (let completedSweeps = 0; completedSweeps < 3; completedSweeps += 1) {
    const current = options.imports.activeGeneration()
    if (!current) return result(options.imports, true, false, pool.concurrency())
    if (current.state === "paused") return result(options.imports, false, false, pool.concurrency())
    let page = Math.max(2, current.discoveryPage + 1)
    while (page <= Math.ceil(upstreamTotal / 100)) {
      if (options.maxPageBatches !== undefined && pageBatches >= options.maxPageBatches)
        return result(options.imports, false, true, pool.concurrency())
      const beforeBatch = options.imports.generationCheckpoint()
      if (!beforeBatch || beforeBatch.discoveryCompleted) return result(options.imports, true, false, pool.concurrency())
      if (beforeBatch.state === "paused") return result(options.imports, false, false, pool.concurrency())
      const batch = Array.from(
        { length: Math.min(options.pageConcurrency ?? 4, Math.ceil(upstreamTotal / 100) - page + 1) },
        (_, index) => page + index,
      )
      await pool.map(batch, async (page) => {
        const loaded = await loadSkillHubPage(options.fetcher, options.baseUrl, page)
        upstreamTotal = Math.max(upstreamTotal, effectiveTotal(loaded.data.total, options.limit))
        options.imports.recordPage(generation.id, page, loaded.data.skills.slice(0, upstreamTotal - (page - 1) * 100), upstreamTotal)
        return loaded
      })
      pageBatches += 1
      page += batch.length
    }
    const completion = options.imports.completeSweep(generation.id)
    if (completion.stable) return result(options.imports, true, false, pool.concurrency())
    if (completedSweeps === 2) return result(options.imports, false, true, pool.concurrency())
    const beforeNextFirst = options.imports.generationCheckpoint()
    if (!beforeNextFirst || beforeNextFirst.discoveryCompleted) return result(options.imports, true, false, pool.concurrency())
    if (beforeNextFirst.state === "paused") return result(options.imports, false, false, pool.concurrency())
    const [nextFirst] = await pool.map([1], (page) => loadSkillHubPage(options.fetcher, options.baseUrl, page))
    upstreamTotal = effectiveTotal(nextFirst.data.total, options.limit)
    options.imports.recordPage(generation.id, 1, nextFirst.data.skills.slice(0, upstreamTotal), upstreamTotal)
  }
  return result(options.imports, false, true, pool.concurrency())
}

function result(imports: SkillHubImportStore, completed: boolean, stale: boolean, pageConcurrency: number): SkillHubDiscoveryResult {
  return { discovered: imports.progress().discovered, completed, stale, pageConcurrency }
}

function effectiveTotal(total: number, limit: number | undefined) {
  return limit === undefined ? total : Math.min(total, limit)
}
