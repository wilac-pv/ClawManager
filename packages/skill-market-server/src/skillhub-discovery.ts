import { createAdaptivePool } from "./adaptive-pool"
import type { SkillHubImportStore } from "./skillhub-import-store"
import { loadSkillHubPage, type Fetcher } from "./skillhub"

export interface SkillHubDiscoveryOptions {
  readonly fetcher: Fetcher
  readonly baseUrl: string
  readonly imports: SkillHubImportStore
  readonly pageConcurrency?: number
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
  if (checkpoint?.discoveryCompleted)
    return result(options.imports, true, false, options.pageConcurrency ?? 4)
  if (checkpoint?.state === "paused") return result(options.imports, false, false, options.pageConcurrency ?? 4)

  const pool = createAdaptivePool({
    minimum: 1,
    maximum: options.pageConcurrency ?? 4,
    now: options.now,
    wait: options.wait,
  })
  const [first] = await pool.map([1], (page) => loadSkillHubPage(options.fetcher, options.baseUrl, page))
  let upstreamTotal = checkpoint && checkpoint.discoveryPage > 0 ? Math.max(checkpoint.upstreamTotal, first.data.total) : first.data.total
  const generation = options.imports.beginGeneration(upstreamTotal)
  const active = options.imports.activeGeneration()
  if (!active) return result(options.imports, true, false, options.pageConcurrency ?? 4)
  options.imports.recordPage(generation.id, 1, first.data.skills, upstreamTotal)

  for (let completedSweeps = 0; completedSweeps < 3; completedSweeps += 1) {
    const current = options.imports.activeGeneration()
    if (!current) return result(options.imports, true, false, pool.concurrency())
    if (current.state === "paused") return result(options.imports, false, false, pool.concurrency())
    let page = Math.max(2, current.discoveryPage + 1)
    while (page <= Math.ceil(upstreamTotal / 100)) {
      const beforeBatch = options.imports.generationCheckpoint()
      if (!beforeBatch || beforeBatch.discoveryCompleted) return result(options.imports, true, false, pool.concurrency())
      if (beforeBatch.state === "paused") return result(options.imports, false, false, pool.concurrency())
      const batch = Array.from(
        { length: Math.min(options.pageConcurrency ?? 4, Math.ceil(upstreamTotal / 100) - page + 1) },
        (_, index) => page + index,
      )
      await pool.map(batch, async (page) => {
        const loaded = await loadSkillHubPage(options.fetcher, options.baseUrl, page)
        upstreamTotal = Math.max(upstreamTotal, loaded.data.total)
        options.imports.recordPage(generation.id, page, loaded.data.skills, upstreamTotal)
        return loaded
      })
      page += batch.length
    }
    const completion = options.imports.completeSweep(generation.id)
    if (completion.stable) return result(options.imports, true, false, pool.concurrency())
    if (completedSweeps === 2) return result(options.imports, false, true, pool.concurrency())
    const beforeNextFirst = options.imports.generationCheckpoint()
    if (!beforeNextFirst || beforeNextFirst.discoveryCompleted) return result(options.imports, true, false, pool.concurrency())
    if (beforeNextFirst.state === "paused") return result(options.imports, false, false, pool.concurrency())
    const [nextFirst] = await pool.map([1], (page) => loadSkillHubPage(options.fetcher, options.baseUrl, page))
    upstreamTotal = nextFirst.data.total
    options.imports.recordPage(generation.id, 1, nextFirst.data.skills, upstreamTotal)
  }
  return result(options.imports, false, true, pool.concurrency())
}

function result(imports: SkillHubImportStore, completed: boolean, stale: boolean, pageConcurrency: number): SkillHubDiscoveryResult {
  return { discovered: imports.progress().discovered, completed, stale, pageConcurrency }
}
