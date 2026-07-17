import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import type { Database } from "bun:sqlite"
import { Option, Schema } from "effect"
import { SkillHubListRecord, type SkillHubRecord } from "./skillhub"
import { MarketDatabase } from "./database"

export interface ClaimedSkillHubItem {
  readonly slug: string
  readonly upstreamVersion: string
  readonly upstreamUpdatedAt: number
  readonly attempts: number
  readonly list: SkillHubListRecord
}

export interface MirroredSkillHubEntry {
  readonly summary: SkillMarket.Summary
  readonly detailKey: string
  readonly detailSha256: string
}

export interface CompletedSkillHubImport {
  readonly entry: MirroredSkillHubEntry
  readonly record: SkillHubRecord
  readonly originalPackageSha256: string
  readonly packageSha256: string
  readonly packageSize: number
  readonly repairs: readonly string[]
}

export interface ActiveSkillHubGeneration {
  readonly id: string
  readonly state: "running" | "paused"
  readonly upstreamTotal: number
  readonly discoveryPage: number
  readonly sweep: number
  readonly newInSweep: number
}

export interface SkillHubGenerationCheckpoint extends ActiveSkillHubGeneration {
  readonly discoveryCompleted: boolean
}

export interface SkillHubPublicationCheckpoint {
  readonly lastPublishedCount: number
  readonly lastPublishedAt?: string
}

export interface LegacyMirroredSkillHubEntry extends MirroredSkillHubEntry {
  readonly slug: string
}

export interface RetriedRejectedSkillHubItem {
  readonly slug: string
  readonly code: SkillMarketControl.SkillHubImportErrorCode
  readonly summary: string
}

export interface SkillHubImportCommandTransition {
  readonly progress: SkillMarketControl.SkillHubImportProgress
  readonly retriedRejected: readonly RetriedRejectedSkillHubItem[]
}

export interface SkillHubImportStore {
  readonly beginGeneration: (upstreamTotal: number) => { readonly id: string }
  readonly activeGeneration: () => ActiveSkillHubGeneration | undefined
  readonly generationCheckpoint: () => SkillHubGenerationCheckpoint | undefined
  readonly recordPage: (
    generationID: string,
    page: number,
    items: readonly SkillHubListRecord[],
    upstreamTotal?: number,
  ) => { readonly inserted: number }
  readonly completeSweep: (generationID: string) => { readonly stable: boolean }
  readonly claim: (workerID: string, limit: number, leaseMilliseconds: number) => ClaimedSkillHubItem[]
  readonly renew: (workerID: string, slug: string, leaseMilliseconds: number) => boolean
  readonly complete: (workerID: string, slug: string, result: CompletedSkillHubImport) => boolean
  readonly retry: (
    workerID: string,
    slug: string,
    code: SkillMarketControl.SkillHubImportErrorCode,
    summary: string,
    retryAt: number,
  ) => boolean
  readonly reject: (
    workerID: string,
    slug: string,
    code: SkillMarketControl.SkillHubImportErrorCode,
    summary: string,
  ) => boolean
  readonly recordPublication: (mirroredCount: number) => boolean
  readonly publicationCheckpoint: () => SkillHubPublicationCheckpoint
  readonly progress: () => SkillMarketControl.SkillHubImportProgress
  readonly command: (input: SkillMarketControl.SkillHubImportCommandInput) => SkillMarketControl.SkillHubImportProgress
  readonly commandTransition: (
    input: SkillMarketControl.SkillHubImportCommandInput,
  ) => SkillHubImportCommandTransition
  readonly mirroredEntries: () => MirroredSkillHubEntry[]
  readonly seedLegacy: (entries: readonly LegacyMirroredSkillHubEntry[]) => number
}

export function createSkillHubImportStore(options: {
  readonly database: MarketDatabase
  readonly now?: () => number
  readonly metadataConcurrency?: number
  readonly packageConcurrency?: number
}): SkillHubImportStore {
  const now = options.now ?? Date.now
  const metadataConcurrency = options.metadataConcurrency ?? 8
  const packageConcurrency = options.packageConcurrency ?? 6

  return {
    beginGeneration(upstreamTotal) {
      return options.database.transaction((connection) => {
        const existing = generationCheckpoint(connection)
        if (existing) {
          if (!existing.discoveryCompleted)
            connection.run(
              "UPDATE skillhub_generations SET upstream_total = ?, updated_at = ? WHERE id = ?",
              [upstreamTotal, now(), existing.id],
            )
          return { id: existing.id }
        }
        const id = `gen_${crypto.randomUUID()}`
        const timestamp = now()
        const publication = strongestPublicationCheckpoint(connection)
        connection.run(
          "INSERT INTO skillhub_generations (id, state, upstream_total, last_published_count, last_published_at, started_at, updated_at) VALUES (?, 'running', ?, ?, ?, ?, ?)",
          [
            id,
            upstreamTotal,
            publication.lastPublishedCount,
            publication.lastPublishedAt ? Date.parse(publication.lastPublishedAt) : null,
            timestamp,
            timestamp,
          ],
        )
        return { id }
      })
    },
    activeGeneration() {
      return options.database.read((connection) => activeGeneration(connection))
    },
    generationCheckpoint() {
      return options.database.read((connection) => generationCheckpoint(connection))
    },
    recordPage(generationID, page, items, upstreamTotal) {
      return options.database.transaction((connection) => {
        const generation = generationRow(connection, generationID)
        const timestamp = now()
        const inserted = items.filter((item) => recordItem(connection, generation, item, timestamp)).length
        connection.run(
          "UPDATE skillhub_generations SET upstream_total = ?, discovery_page = CASE WHEN discovery_page + 1 = ? THEN ? ELSE discovery_page END, new_in_sweep = new_in_sweep + ?, updated_at = ? WHERE id = ?",
          [upstreamTotal ?? generation.upstream_total, page, page, inserted, timestamp, generation.id],
        )
        return { inserted }
      })
    },
    completeSweep(generationID) {
      return options.database.transaction((connection) => {
        const generation = generationRow(connection, generationID)
        const timestamp = now()
        const observed = connection
          .query<{ count: number }, [string, string, number]>(
            "SELECT COUNT(*) AS count FROM skillhub_import_items WHERE generation_id = ? AND last_seen_generation = ? AND last_seen_sweep = ?",
          )
          .get(generationID, generationID, generation.sweep)!.count
        const stable = generation.sweep >= 1 && generation.new_in_sweep === 0 && observed >= generation.upstream_total
        if (stable) {
          connection.run(
            "UPDATE skillhub_generations SET discovery_completed_at = ?, updated_at = ? WHERE id = ?",
            [timestamp, timestamp, generationID],
          )
          finishGenerationIfSettled(connection, generationID, timestamp)
          return { stable }
        }
        connection.run(
          "UPDATE skillhub_generations SET discovery_page = 0, sweep = sweep + 1, new_in_sweep = 0, updated_at = ? WHERE id = ?",
          [timestamp, generationID],
        )
        return { stable }
      })
    },
    claim(workerID, limit, leaseMilliseconds) {
      if (workerID.length < 1 || workerID.length > 128) throw new Error("SkillHub worker ID must contain 1 to 128 characters")
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > packageConcurrency)
        throw new Error(`SkillHub claim limit must be between 1 and ${packageConcurrency}`)
      if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1 || leaseMilliseconds > 86_400_000)
        throw new Error("SkillHub lease must be between 1 millisecond and 24 hours")
      return options.database.transaction((connection) => {
        const timestamp = now()
        const rows = connection
          .query<ClaimRow, [number, number, number]>(
            "SELECT item.slug, item.upstream_version, item.upstream_updated_at, item.attempts, item.list_json FROM skillhub_import_items AS item JOIN skillhub_generations AS generation ON generation.id = item.generation_id WHERE generation.state = 'running' AND (item.state = 'pending' OR (item.state = 'retry_wait' AND item.next_attempt_at <= ?) OR (item.state = 'running' AND item.lease_expires_at <= ?)) ORDER BY item.updated_at, item.slug LIMIT ?",
          )
          .all(timestamp, timestamp, limit)
        rows.forEach((row) => {
          connection.run(
            "UPDATE skillhub_import_items SET state = 'running', attempts = attempts + 1, next_attempt_at = NULL, lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE slug = ?",
            [workerID, timestamp + leaseMilliseconds, timestamp, row.slug],
          )
        })
        return rows.map((row) => ({
          slug: row.slug,
          upstreamVersion: row.upstream_version,
          upstreamUpdatedAt: row.upstream_updated_at,
          attempts: row.attempts + 1,
          list: Schema.decodeUnknownSync(Schema.fromJsonString(SkillHubListRecord))(row.list_json),
        }))
      })
    },
    renew(workerID, slug, leaseMilliseconds) {
      if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1 || leaseMilliseconds > 86_400_000)
        throw new Error("SkillHub lease must be between 1 millisecond and 24 hours")
      return options.database.transaction((connection) => {
        const timestamp = now()
        return connection.run(
          "UPDATE skillhub_import_items SET lease_expires_at = ?, updated_at = ? WHERE slug = ? AND state = 'running' AND lease_owner = ? AND lease_expires_at > ?",
          [timestamp + leaseMilliseconds, timestamp, slug, workerID, timestamp],
        ).changes === 1
      })
    },
    complete(workerID, slug, result) {
      return options.database.transaction((connection) => {
        const timestamp = now()
        const item = connection
          .query<{ generation_id: string }, [string, string, number]>(
            "SELECT generation_id FROM skillhub_import_items WHERE slug = ? AND state = 'running' AND lease_owner = ? AND lease_expires_at > ?",
          )
          .get(slug, workerID, timestamp)
        if (!item) return false
        connection.run(
          "UPDATE skillhub_import_items SET state = 'mirrored', lease_owner = NULL, lease_expires_at = NULL, record_json = ?, summary_json = ?, detail_key = ?, detail_sha256 = ?, original_package_sha256 = ?, package_sha256 = ?, package_size = ?, repair_json = ?, error_code = NULL, error_summary = NULL, mirrored_at = ?, updated_at = ? WHERE slug = ?",
          [
            JSON.stringify(result.record),
            JSON.stringify(result.entry.summary),
            result.entry.detailKey,
            result.entry.detailSha256,
            result.originalPackageSha256,
            result.packageSha256,
            result.packageSize,
            JSON.stringify(result.repairs),
            timestamp,
            timestamp,
            slug,
          ],
        )
        connection.run(
          "UPDATE skillhub_generations SET uploaded_bytes = uploaded_bytes + ?, updated_at = ? WHERE id = ?",
          [result.packageSize, timestamp, item.generation_id],
        )
        finishGenerationIfSettled(connection, item.generation_id, timestamp)
        return true
      })
    },
    retry(workerID, slug, code, summary, retryAt) {
      return transitionFailure(options.database, now, workerID, slug, code, summary, retryAt, "retry_wait")
    },
    reject(workerID, slug, code, summary) {
      return transitionFailure(options.database, now, workerID, slug, code, summary, undefined, "rejected")
    },
    recordPublication(mirroredCount) {
      return options.database.transaction((connection) => {
        if (!Number.isInteger(mirroredCount) || mirroredCount < 0) return false
        const timestamp = now()
        const generation = currentGeneration(connection)
        if (!generation) return false
        const checkpoint = publicationCheckpoint(connection)
        if (mirroredCount < checkpoint.lastPublishedCount) return false
        return (
          connection.run(
            "UPDATE skillhub_generations SET last_published_count = ?, last_published_at = ?, updated_at = ? WHERE id = ?",
            [mirroredCount, timestamp, timestamp, generation.id],
          ).changes === 1
        )
      })
    },
    publicationCheckpoint() {
      return options.database.read((connection) => publicationCheckpoint(connection))
    },
    progress() {
      return options.database.read((connection) => readProgress(connection, now(), metadataConcurrency, packageConcurrency))
    },
    command(input) {
      return options.database.transaction((connection) => {
        return applyCommand(connection, input, now(), metadataConcurrency, packageConcurrency).progress
      })
    },
    commandTransition(input) {
      return options.database.transaction((connection) => {
        return applyCommand(connection, input, now(), metadataConcurrency, packageConcurrency)
      })
    },
    mirroredEntries() {
      return options.database.read((connection) =>
        connection
          .query<MirroredRow, []>(
            "SELECT summary_json, detail_key, detail_sha256 FROM skillhub_import_items WHERE state = 'mirrored' ORDER BY slug",
          )
          .all()
          .flatMap((row) =>
            row.summary_json && row.detail_key && row.detail_sha256
              ? [{
                  summary: Schema.decodeUnknownSync(Schema.fromJsonString(SkillMarket.Summary))(row.summary_json),
                  detailKey: row.detail_key,
                  detailSha256: row.detail_sha256,
                }]
              : [],
          ),
      )
    },
    seedLegacy(entries) {
      return options.database.transaction((connection) => {
        const missing = entries.filter(
          (entry) =>
            !connection
              .query<{ present: number }, [string]>("SELECT 1 AS present FROM skillhub_import_items WHERE slug = ?")
              .get(entry.slug),
        )
        if (missing.length === 0) return 0
        const timestamp = now()
        const existingGeneration = currentGeneration(connection)
        const generation = existingGeneration ?? legacyGeneration(connection, missing.length, timestamp)
        const inserted = missing.filter((entry) => {
          const result = connection.run(
            "INSERT INTO skillhub_import_items (slug, generation_id, upstream_version, upstream_updated_at, state, list_json, summary_json, detail_key, detail_sha256, mirrored_at, last_seen_generation, created_at, updated_at) VALUES (?, ?, ?, ?, 'mirrored', '{}', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING",
            [
              entry.slug,
              generation.id,
              entry.summary.version,
              Date.parse(entry.summary.updatedAt),
              JSON.stringify(entry.summary),
              entry.detailKey,
              entry.detailSha256,
              timestamp,
              generation.id,
              timestamp,
              timestamp,
            ],
          )
          return result.changes === 1
        }).length
        if (
          inserted > 0 &&
          existingGeneration &&
          generation.state !== "running" &&
          generation.state !== "paused"
        )
          connection.run(
            "UPDATE skillhub_generations SET upstream_total = upstream_total + ?, updated_at = ? WHERE id = ?",
            [inserted, timestamp, generation.id],
          )
        return inserted
      })
    },
  }
}

type GenerationRow = {
  readonly id: string
  readonly state: "running" | "paused" | "completed" | "failed"
  readonly upstream_total: number
  readonly discovery_page: number
  readonly sweep: number
  readonly new_in_sweep: number
  readonly discovery_completed_at: number | null
}

type CurrentGenerationRow = GenerationRow & {
  readonly uploaded_bytes: number
  readonly updated_at: number
  readonly last_published_count: number
  readonly last_published_at: number | null
  readonly recent_error_code: string | null
  readonly recent_error_summary: string | null
  readonly recent_error_at: number | null
  readonly completed_at: number | null
}

type ClaimRow = {
  readonly slug: string
  readonly upstream_version: string
  readonly upstream_updated_at: number
  readonly attempts: number
  readonly list_json: string
}

type MirroredRow = {
  readonly summary_json: string | null
  readonly detail_key: string | null
  readonly detail_sha256: string | null
}

function activeGeneration(connection: Database): ActiveSkillHubGeneration | undefined {
  const generation = currentGeneration(connection)
  if (
    !generation ||
    (generation.state !== "running" && generation.state !== "paused") ||
    generation.discovery_completed_at !== null
  )
    return undefined
  return {
    id: generation.id,
    state: generation.state as "running" | "paused",
    upstreamTotal: generation.upstream_total,
    discoveryPage: generation.discovery_page,
    sweep: generation.sweep,
    newInSweep: generation.new_in_sweep,
  }
}

function generationCheckpoint(connection: Database): SkillHubGenerationCheckpoint | undefined {
  const generation = currentGeneration(connection)
  if (!generation || (generation.state !== "running" && generation.state !== "paused")) return undefined
  return {
    id: generation.id,
    state: generation.state as "running" | "paused",
    upstreamTotal: generation.upstream_total,
    discoveryPage: generation.discovery_page,
    sweep: generation.sweep,
    newInSweep: generation.new_in_sweep,
    discoveryCompleted: generation.discovery_completed_at !== null,
  }
}

function currentGeneration(connection: Database): CurrentGenerationRow | undefined {
  return connection
    .query<CurrentGenerationRow, []>(
      "SELECT id, state, upstream_total, discovery_page, sweep, new_in_sweep, uploaded_bytes, updated_at, last_published_count, last_published_at, recent_error_code, recent_error_summary, recent_error_at, discovery_completed_at, completed_at FROM skillhub_generations ORDER BY CASE WHEN state IN ('running', 'paused') THEN 0 ELSE 1 END, started_at DESC, rowid DESC LIMIT 1",
    )
    .get() ?? undefined
}

function generationRow(connection: Database, generationID: string) {
  const generation = connection
    .query<GenerationRow, [string]>(
      "SELECT id, state, upstream_total, discovery_page, sweep, new_in_sweep, discovery_completed_at FROM skillhub_generations WHERE id = ? AND state IN ('running', 'paused') AND discovery_completed_at IS NULL",
    )
    .get(generationID)
  if (!generation) throw new Error(`SkillHub import generation ${generationID} is not active`)
  return generation
}

function recordItem(connection: Database, generation: GenerationRow, item: SkillHubListRecord, timestamp: number) {
  const existing = connection
    .query<{ upstream_version: string; upstream_updated_at: number }, [string]>(
      "SELECT upstream_version, upstream_updated_at FROM skillhub_import_items WHERE slug = ?",
    )
    .get(item.slug)
  if (!existing) {
    connection.run(
      "INSERT INTO skillhub_import_items (slug, generation_id, upstream_version, upstream_updated_at, state, list_json, last_seen_generation, last_seen_sweep, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
      [
        item.slug,
        generation.id,
        item.version,
        item.updated_at,
        JSON.stringify(item),
        generation.id,
        generation.sweep,
        timestamp,
        timestamp,
      ],
    )
    return true
  }
  if (existing.upstream_version === item.version && existing.upstream_updated_at === item.updated_at) {
    connection.run(
      "UPDATE skillhub_import_items SET generation_id = ?, last_seen_generation = ?, last_seen_sweep = ?, list_json = ?, updated_at = ? WHERE slug = ?",
      [generation.id, generation.id, generation.sweep, JSON.stringify(item), timestamp, item.slug],
    )
    return false
  }
  connection.run(
    "UPDATE skillhub_import_items SET generation_id = ?, upstream_version = ?, upstream_updated_at = ?, state = 'pending', attempts = 0, next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, list_json = ?, record_json = NULL, summary_json = NULL, detail_key = NULL, detail_sha256 = NULL, original_package_sha256 = NULL, package_sha256 = NULL, package_size = NULL, repair_json = NULL, error_code = NULL, error_summary = NULL, mirrored_at = NULL, last_seen_generation = ?, last_seen_sweep = ?, updated_at = ? WHERE slug = ?",
    [generation.id, item.version, item.updated_at, JSON.stringify(item), generation.id, generation.sweep, timestamp, item.slug],
  )
  return false
}

function transitionFailure(
  database: MarketDatabase,
  now: () => number,
  workerID: string,
  slug: string,
  code: SkillMarketControl.SkillHubImportErrorCode,
  summary: string,
  retryAt: number | undefined,
  state: "retry_wait" | "rejected",
) {
  return database.transaction((connection) => {
    const timestamp = now()
    const item = connection
      .query<{ generation_id: string }, [string, string, number]>(
        "SELECT generation_id FROM skillhub_import_items WHERE slug = ? AND state = 'running' AND lease_owner = ? AND lease_expires_at > ?",
      )
      .get(slug, workerID, timestamp)
    if (!item) return false
    const bounded = summary.slice(0, 500) || "Unclassified SkillHub import error"
    connection.run(
      "UPDATE skillhub_import_items SET state = ?, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, error_code = ?, error_summary = ?, updated_at = ? WHERE slug = ?",
      [state, retryAt ?? null, code, bounded, timestamp, slug],
    )
    connection.run(
      "UPDATE skillhub_generations SET recent_error_code = ?, recent_error_summary = ?, recent_error_at = ?, updated_at = ? WHERE id = ?",
      [code, bounded, timestamp, timestamp, item.generation_id],
    )
    if (state === "rejected") finishGenerationIfSettled(connection, item.generation_id, timestamp)
    return true
  })
}

function applyCommand(
  connection: Database,
  input: SkillMarketControl.SkillHubImportCommandInput,
  timestamp: number,
  metadataConcurrency: number,
  packageConcurrency: number,
): SkillHubImportCommandTransition {
  if (input.command === "pause")
    connection.run("UPDATE skillhub_generations SET state = 'paused', updated_at = ? WHERE state = 'running'", [timestamp])
  if (input.command === "resume")
    connection.run("UPDATE skillhub_generations SET state = 'running', updated_at = ? WHERE state = 'paused'", [timestamp])
  if (input.command === "retry-wait")
    connection.run(
      "UPDATE skillhub_import_items SET state = 'pending', next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'retry_wait'",
      [timestamp],
    )
  const retriedRejected = input.command === "retry-rejected" ? retryRejected(connection, input.slugs, timestamp) : []
  return {
    progress: readProgress(connection, timestamp, metadataConcurrency, packageConcurrency),
    retriedRejected,
  }
}

function retryRejected(connection: Database, slugs: readonly string[], timestamp: number) {
  const items = slugs.flatMap((slug) => {
    const item = connection
      .query<{ generation_id: string; error_code: string | null; error_summary: string | null }, [string]>(
        "SELECT generation_id, error_code, error_summary FROM skillhub_import_items WHERE slug = ? AND state = 'rejected'",
      )
      .get(slug)
    if (!item?.error_code || !item.error_summary) return []
    const code = Option.getOrUndefined(
      Schema.decodeUnknownOption(SkillMarketControl.SkillHubImportErrorCode)(item.error_code),
    )
    if (!code) return []
    return [{ slug, generationID: item.generation_id, code, summary: item.error_summary }]
  })
  if (items.length === 0) return []
  const existing = generationCheckpoint(connection)
  const generationID = existing?.id ?? items[0]!.generationID
  if (!existing) {
    const reopened = connection.run(
      "UPDATE skillhub_generations SET state = 'running', completed_at = NULL, updated_at = ? WHERE id = ? AND state = 'completed'",
      [timestamp, generationID],
    ).changes
    if (reopened !== 1) return []
  }
  return items.flatMap((item) => {
    const changed = connection.run(
      "UPDATE skillhub_import_items SET generation_id = ?, state = 'pending', next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, error_summary = NULL, updated_at = ? WHERE slug = ? AND state = 'rejected'",
      [generationID, timestamp, item.slug],
    ).changes
    return changed === 1 ? [{ slug: item.slug, code: item.code, summary: item.summary }] : []
  })
}

function finishGenerationIfSettled(connection: Database, generationID: string, timestamp: number) {
  connection.run(
    "UPDATE skillhub_generations SET state = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND discovery_completed_at IS NOT NULL AND completed_at IS NULL AND NOT EXISTS (SELECT 1 FROM skillhub_import_items WHERE generation_id = ? AND state IN ('pending', 'running', 'retry_wait'))",
    [timestamp, timestamp, generationID, generationID],
  )
}

function readProgress(connection: Database, timestamp: number, metadataConcurrency: number, packageConcurrency: number) {
  const generation = currentGeneration(connection)
  if (!generation) return idleProgress(timestamp, metadataConcurrency, packageConcurrency)
  const counts = connection
    .query<{ readonly state: string; readonly count: number }, [string]>(
      "SELECT state, COUNT(*) AS count FROM skillhub_import_items WHERE generation_id = ? GROUP BY state",
    )
    .all(generation.id)
  const count = (state: string) => counts.find((row) => row.state === state)?.count ?? 0
  const mirrored = count("mirrored")
  const remaining = count("pending") + count("running") + count("retry_wait")
  const ratePerMinute = connection
    .query<{ count: number }, [string, number]>(
      "SELECT COUNT(*) AS count FROM skillhub_import_items WHERE generation_id = ? AND state = 'mirrored' AND mirrored_at > ?",
    )
    .get(generation.id, timestamp - 60_000)!.count
  const estimatedSecondsRemaining = ratePerMinute === 0 ? undefined : Math.ceil((remaining / ratePerMinute) * 60)
  return Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportProgress)({
    state: generation.completed_at !== null && remaining === 0 ? "completed" : generation.state,
    sourceStatus:
      generation.completed_at !== null && remaining === 0
        ? "fresh"
        : generation.state === "failed"
          ? "unavailable"
          : "stale",
    upstreamTotal: generation.upstream_total,
    discovered: counts.reduce((total, row) => total + row.count, 0),
    pending: count("pending"),
    running: count("running"),
    mirrored,
    retryWait: count("retry_wait"),
    rejected: count("rejected"),
    uploadedBytes: generation.uploaded_bytes,
    ratePerMinute,
    ...(estimatedSecondsRemaining === undefined ? {} : { estimatedSecondsRemaining }),
    ...(generation.last_published_at === null ? {} : { lastPublishedAt: iso(generation.last_published_at) }),
    ...(generation.recent_error_code === null || generation.recent_error_summary === null || generation.recent_error_at === null
      ? {}
      : {
          recentError: {
            code: progressErrorCode(generation.recent_error_code),
            summary: generation.recent_error_summary,
            occurredAt: iso(generation.recent_error_at),
          },
        }),
    discoveryPage: generation.discovery_page,
    sweep: generation.sweep,
    metadataConcurrency,
    packageConcurrency,
    updatedAt: iso(generation.updated_at),
  })
}

function idleProgress(timestamp: number, metadataConcurrency: number, packageConcurrency: number) {
  return Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportProgress)({
    state: "idle",
    sourceStatus: "unavailable",
    upstreamTotal: 0,
    discovered: 0,
    pending: 0,
    running: 0,
    mirrored: 0,
    retryWait: 0,
    rejected: 0,
    uploadedBytes: 0,
    ratePerMinute: 0,
    discoveryPage: 0,
    sweep: 0,
    metadataConcurrency,
    packageConcurrency,
    updatedAt: iso(timestamp),
  })
}

function legacyGeneration(connection: Database, total: number, timestamp: number) {
  const id = `legacy_${crypto.randomUUID()}`
  const publication = strongestPublicationCheckpoint(connection)
  connection.run(
    "INSERT INTO skillhub_generations (id, state, upstream_total, last_published_count, last_published_at, started_at, updated_at, discovery_completed_at, completed_at) VALUES (?, 'completed', ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      total,
      publication.lastPublishedCount,
      publication.lastPublishedAt ? Date.parse(publication.lastPublishedAt) : null,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    ],
  )
  return { id, state: "completed" as const }
}

function publicationCheckpoint(connection: Database): SkillHubPublicationCheckpoint {
  const generation = currentGeneration(connection)
  return checkpointFromGeneration(generation)
}

function strongestPublicationCheckpoint(connection: Database): SkillHubPublicationCheckpoint {
  const generation = connection
    .query<{ last_published_count: number; last_published_at: number | null }, []>(
      "SELECT last_published_count, last_published_at FROM skillhub_generations ORDER BY last_published_count DESC, last_published_at DESC, started_at DESC, rowid DESC LIMIT 1",
    )
    .get()
  return checkpointFromGeneration(generation)
}

function checkpointFromGeneration(
  generation: { readonly last_published_count: number; readonly last_published_at: number | null } | null | undefined,
): SkillHubPublicationCheckpoint {
  if (!generation) return { lastPublishedCount: 0 }
  return {
    lastPublishedCount: generation.last_published_count,
    ...(generation.last_published_at === null ? {} : { lastPublishedAt: iso(generation.last_published_at) }),
  }
}

function progressErrorCode(code: string) {
  return Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportErrorCode)(code)
}

function iso(timestamp: number) {
  return new Date(timestamp).toISOString()
}
