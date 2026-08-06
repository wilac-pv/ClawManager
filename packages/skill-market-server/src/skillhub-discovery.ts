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
  const progress = await options.imports.progress()
  const checkpoint = await options.imports.generationCheckpoint()
  const completed = progress.state === "completed"
  if (checkpoint?.discoveryCompleted)
    return await result(options.imports, true, false, options.pageConcurrency ?? 4)
  if (checkpoint?.state === "paused") return await result(options.imports, false, false, options.pageConcurrency ?? 4)
  if (
    !options.refresh &&
    completed &&
    (options.limit === undefined || options.limit <= progress.upstreamTotal)
  )
    return await result(options.imports, true, false, options.pageConcurrency ?? 4)

  const pool = createAdaptivePool({
    minimum: 1,
    maximum: options.pageConcurrency ?? 4,
    now: options.now,
    wait: options.wait,
  })
  const [first] = await pool.map([1], (page) => loadSkillHubPage(options.fetcher, options.baseUrl, page))
  let pageBatches = 0
  let upstreamTotal = effectiveTotal(first.data.total, options.limit)
  const progressAfterFirst = await options.imports.progress()
  if (completed && upstreamTotal === progressAfterFirst.upstreamTotal)
    return await result(options.imports, true, false, pool.concurrency())
  if (checkpoint && checkpoint.discoveryPage > 0) upstreamTotal = Math.max(checkpoint.upstreamTotal, upstreamTotal)
  const generation = await options.imports.beginGeneration(upstreamTotal)
  const active = await options.imports.activeGeneration()
  if (!active) return await result(options.imports, true, false, options.pageConcurrency ?? 4)
  await options.imports.recordPage(generation.id, 1, first.data.skills.slice(0, upstreamTotal), upstreamTotal)

  for (let completedSweeps = 0; completedSweeps < 3; completedSweeps += 1) {
    const current = await options.imports.activeGeneration()
    if (!current) return await result(options.imports, true, false, pool.concurrency())
    if (current.state === "paused") return await result(options.imports, false, false, pool.concurrency())
    let page = Math.max(2, current.discoveryPage + 1)
    while (page <= Math.ceil(upstreamTotal / 100)) {
      if (options.maxPageBatches !== undefined && pageBatches >= options.maxPageBatches)
        return await result(options.imports, false, true, pool.concurrency())
      const beforeBatch = await options.imports.generationCheckpoint()
      if (!beforeBatch || beforeBatch.discoveryCompleted)
        return await result(options.imports, true, false, pool.concurrency())
      if (beforeBatch.state === "paused")
        return await result(options.imports, false, false, pool.concurrency())
      const batch = Array.from(
        { length: Math.min(options.pageConcurrency ?? 4, Math.ceil(upstreamTotal / 100) - page + 1) },
        (_, index) => page + index,
      )
      const loaded = await pool.map(batch, (page) => loadSkillHubPage(options.fetcher, options.baseUrl, page))
      upstreamTotal = Math.max(
        upstreamTotal,
        ...loaded.map((page) => effectiveTotal(page.data.total, options.limit)),
      )
      for (let index = 0; index < loaded.length; index++) {
        await options.imports.recordPage(
          generation.id,
          batch[index]!,
          loaded[index]!.data.skills.slice(0, upstreamTotal - (batch[index]! - 1) * 100),
          upstreamTotal,
        )
      }
      pageBatches += 1
      page += batch.length
    }
    const completion = await options.imports.completeSweep(generation.id)
    if (completion.stable) return await result(options.imports, true, false, pool.concurrency())
    if (completedSweeps === 2) return await result(options.imports, false, true, pool.concurrency())
    const beforeNextFirst = await options.imports.generationCheckpoint()
    if (!beforeNextFirst || beforeNextFirst.discoveryCompleted)
      return await result(options.imports, true, false, pool.concurrency())
    if (beforeNextFirst.state === "paused")
      return await result(options.imports, false, false, pool.concurrency())
    const [nextFirst] = await pool.map([1], (page) => loadSkillHubPage(options.fetcher, options.baseUrl, page))
    upstreamTotal = effectiveTotal(nextFirst.data.total, options.limit)
    await options.imports.recordPage(generation.id, 1, nextFirst.data.skills.slice(0, upstreamTotal), upstreamTotal)
  }
  return await result(options.imports, false, true, pool.concurrency())
}

async function result(imports: SkillHubImportStore, completed: boolean, stale: boolean, pageConcurrency: number): Promise<SkillHubDiscoveryResult> {
  const progress = await imports.progress()
  return { discovered: progress.discovered, completed, stale, pageConcurrency }
}

function effectiveTotal(total: number, limit: number | undefined) {
  return limit === undefined ? total : Math.min(total, limit)
}
