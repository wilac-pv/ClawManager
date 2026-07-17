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
  let upstreamTotal = first.data.total
  const generation = options.imports.beginGeneration(first.data.total)
  const active = options.imports.activeGeneration()
  if (!active) return result(options.imports, true, false, options.pageConcurrency ?? 4)
  options.imports.recordPage(generation.id, 1, first.data.skills, first.data.total)

  for (let completedSweeps = 0; completedSweeps < 3; completedSweeps += 1) {
    const current = options.imports.activeGeneration()
    if (!current) return result(options.imports, true, false, pool.concurrency())
    if (current.state === "paused") return result(options.imports, false, false, pool.concurrency())
    const start = Math.max(2, current.discoveryPage + 1)
    const pages = Array.from({ length: Math.max(0, Math.ceil(upstreamTotal / 100) - start + 1) }, (_, index) => start + index)
    for (let offset = 0; offset < pages.length; offset += options.pageConcurrency ?? 4) {
      const batch = pages.slice(offset, offset + (options.pageConcurrency ?? 4))
      await pool.map(batch, async (page) => {
        const loaded = await loadSkillHubPage(options.fetcher, options.baseUrl, page)
        options.imports.recordPage(generation.id, page, loaded.data.skills, loaded.data.total)
        return loaded
      })
    }
    const completion = options.imports.completeSweep(generation.id)
    if (completion.stable) return result(options.imports, true, false, pool.concurrency())
    if (completedSweeps === 2) return result(options.imports, false, true, pool.concurrency())
    const next = options.imports.activeGeneration()
    if (!next || next.state === "paused") return result(options.imports, false, false, pool.concurrency())
    const [nextFirst] = await pool.map([1], (page) => loadSkillHubPage(options.fetcher, options.baseUrl, page))
    options.imports.recordPage(generation.id, 1, nextFirst.data.skills, nextFirst.data.total)
    upstreamTotal = nextFirst.data.total
  }
  return result(options.imports, false, true, pool.concurrency())
}

function result(imports: SkillHubImportStore, completed: boolean, stale: boolean, pageConcurrency: number): SkillHubDiscoveryResult {
  return { discovered: imports.progress().discovered, completed, stale, pageConcurrency }
}
