import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import type { Database } from "bun:sqlite"
import { Schema } from "effect"
import type { MarketDatabase } from "./database"
import type { SkillHubEvaluation } from "./skillhub-evaluation"

const maximumClaimLimit = 2
const defaultMaximumAttempts = 5
const defaultBaseDelayMilliseconds = 1_000
const defaultMaximumDelayMilliseconds = 60 * 60 * 1_000
const defaultRefreshMilliseconds = 7 * 24 * 60 * 60 * 1_000

const EvaluationResult = Schema.Struct({
  trust: SkillMarket.EvaluationScore,
  reliability: SkillMarket.EvaluationScore,
  adaptability: SkillMarket.EvaluationScore,
  convention: SkillMarket.EvaluationScore,
  effectiveness: SkillMarket.EvaluationScore,
  score: SkillMarket.EvaluationScore,
})

export interface ClaimedSkillHubEvaluation {
  readonly slug: string
  readonly attempts: number
}

export interface SkillHubEvaluationRetryPolicy {
  readonly maximumAttempts?: number
  readonly baseDelayMilliseconds?: number
  readonly maximumDelayMilliseconds?: number
}

export interface SkillHubEvaluationStore {
  readonly claim: (workerID: string, limit: number, leaseMilliseconds: number) => ClaimedSkillHubEvaluation[]
  readonly renew: (workerID: string, slug: string, leaseMilliseconds: number) => boolean
  readonly complete: (workerID: string, slug: string, evaluation: SkillHubEvaluation) => boolean
  readonly retry: (workerID: string, slug: string, summary: string, policy?: SkillHubEvaluationRetryPolicy) => boolean
  readonly progress: () => SkillMarketControl.SkillHubEvaluationProgress
  readonly markDue: (refreshMilliseconds?: number) => number
}

export function createSkillHubEvaluationStore(options: {
  readonly database: MarketDatabase
  readonly now?: () => number
}): SkillHubEvaluationStore {
  const now = options.now ?? Date.now
  return {
    claim(workerID, limit, leaseMilliseconds) {
      requireWorkerID(workerID)
      requireClaimLimit(limit)
      requireLeaseMilliseconds(leaseMilliseconds)
      return options.database.transaction((connection) => {
        const timestamp = now()
        const rows = connection
          .query<ClaimRow, [number, number, number]>(
            "SELECT slug, evaluation_attempts FROM skillhub_import_items WHERE state = 'mirrored' AND (evaluation_state = 'pending' OR (evaluation_state = 'retry_wait' AND evaluation_next_attempt_at <= ?) OR (evaluation_state = 'running' AND evaluation_lease_expires_at <= ?)) ORDER BY updated_at, slug LIMIT ?",
          )
          .all(timestamp, timestamp, limit)
        rows.forEach((row) => {
          connection.run(
            "UPDATE skillhub_import_items SET evaluation_state = 'running', evaluation_attempts = evaluation_attempts + 1, evaluation_next_attempt_at = NULL, evaluation_lease_owner = ?, evaluation_lease_expires_at = ?, updated_at = ? WHERE slug = ?",
            [workerID, timestamp + leaseMilliseconds, timestamp, row.slug],
          )
        })
        return rows.map((row) => ({ slug: row.slug, attempts: row.evaluation_attempts + 1 }))
      })
    },
    renew(workerID, slug, leaseMilliseconds) {
      requireWorkerID(workerID)
      requireLeaseMilliseconds(leaseMilliseconds)
      return options.database.transaction((connection) => {
        const timestamp = now()
        return connection.run(
          "UPDATE skillhub_import_items SET evaluation_lease_expires_at = ?, updated_at = ? WHERE slug = ? AND state = 'mirrored' AND evaluation_state = 'running' AND evaluation_lease_owner = ? AND evaluation_lease_expires_at > ?",
          [timestamp + leaseMilliseconds, timestamp, slug, workerID, timestamp],
        ).changes === 1
      })
    },
    complete(workerID, slug, evaluation) {
      requireWorkerID(workerID)
      const result = Schema.decodeUnknownSync(EvaluationResult)(evaluation)
      return options.database.transaction((connection) => {
        const timestamp = now()
        const item = connection
          .query<{ readonly summary_json: string | null }, [string, string, number]>(
            "SELECT summary_json FROM skillhub_import_items WHERE slug = ? AND state = 'mirrored' AND evaluation_state = 'running' AND evaluation_lease_owner = ? AND evaluation_lease_expires_at > ?",
          )
          .get(slug, workerID, timestamp)
        if (!item?.summary_json) return false
        const summary = Schema.decodeUnknownSync(Schema.fromJsonString(SkillMarket.Summary))(item.summary_json)
        const evaluatedAt = iso(timestamp)
        const updated = {
          ...summary,
          evaluationScore: result.score,
          traceEvaluation: {
            trust: result.trust,
            reliability: result.reliability,
            adaptability: result.adaptability,
            convention: result.convention,
            effectiveness: result.effectiveness,
            evaluatedAt,
          },
        }
        return connection.run(
          "UPDATE skillhub_import_items SET evaluation_state = 'completed', evaluation_next_attempt_at = NULL, evaluation_lease_owner = NULL, evaluation_lease_expires_at = NULL, evaluation_trust = ?, evaluation_reliability = ?, evaluation_adaptability = ?, evaluation_convention = ?, evaluation_effectiveness = ?, evaluation_score = ?, evaluation_checked_at = ?, evaluation_error_summary = NULL, summary_json = ?, updated_at = ? WHERE slug = ? AND state = 'mirrored' AND evaluation_state = 'running' AND evaluation_lease_owner = ? AND evaluation_lease_expires_at > ?",
          [
            result.trust,
            result.reliability,
            result.adaptability,
            result.convention,
            result.effectiveness,
            result.score,
            timestamp,
            JSON.stringify(updated),
            timestamp,
            slug,
            workerID,
            timestamp,
          ],
        ).changes === 1
      })
    },
    retry(workerID, slug, summary, policy = {}) {
      requireWorkerID(workerID)
      const maximumAttempts = policy.maximumAttempts ?? defaultMaximumAttempts
      const baseDelayMilliseconds = policy.baseDelayMilliseconds ?? defaultBaseDelayMilliseconds
      const maximumDelayMilliseconds = policy.maximumDelayMilliseconds ?? defaultMaximumDelayMilliseconds
      requireRetryPolicy(maximumAttempts, baseDelayMilliseconds, maximumDelayMilliseconds)
      return options.database.transaction((connection) => {
        const timestamp = now()
        const item = connection
          .query<{ readonly evaluation_attempts: number }, [string, string, number]>(
            "SELECT evaluation_attempts FROM skillhub_import_items WHERE slug = ? AND state = 'mirrored' AND evaluation_state = 'running' AND evaluation_lease_owner = ? AND evaluation_lease_expires_at > ?",
          )
          .get(slug, workerID, timestamp)
        if (!item) return false
        const error = boundedSummary(summary)
        const failed = item.evaluation_attempts >= maximumAttempts
        const nextAttemptAt = failed
          ? null
          : timestamp + Math.min(maximumDelayMilliseconds, baseDelayMilliseconds * 2 ** (item.evaluation_attempts - 1))
        return connection.run(
          "UPDATE skillhub_import_items SET evaluation_state = ?, evaluation_next_attempt_at = ?, evaluation_lease_owner = NULL, evaluation_lease_expires_at = NULL, evaluation_error_summary = ?, updated_at = ? WHERE slug = ? AND state = 'mirrored' AND evaluation_state = 'running' AND evaluation_lease_owner = ? AND evaluation_lease_expires_at > ?",
          [failed ? "failed" : "retry_wait", nextAttemptAt, error, timestamp, slug, workerID, timestamp],
        ).changes === 1
      })
    },
    progress() {
      return options.database.read((connection) => readProgress(connection, now()))
    },
    markDue(refreshMilliseconds = defaultRefreshMilliseconds) {
      if (!Number.isSafeInteger(refreshMilliseconds) || refreshMilliseconds < 1 || refreshMilliseconds > 366 * 24 * 60 * 60 * 1_000)
        throw new Error("SkillHub evaluation refresh must be between 1 millisecond and 366 days")
      return options.database.transaction((connection) => {
        const timestamp = now()
        return connection.run(
          "UPDATE skillhub_import_items SET evaluation_state = 'pending', evaluation_attempts = 0, evaluation_next_attempt_at = NULL, evaluation_lease_owner = NULL, evaluation_lease_expires_at = NULL, updated_at = ? WHERE state = 'mirrored' AND evaluation_state = 'completed' AND evaluation_checked_at <= ?",
          [timestamp, timestamp - refreshMilliseconds],
        ).changes
      })
    },
  }
}

type ClaimRow = {
  readonly slug: string
  readonly evaluation_attempts: number
}

type EvaluationCountRow = {
  readonly evaluation_state: string
  readonly count: number
}

function requireWorkerID(workerID: string) {
  if (workerID.length < 1 || workerID.length > 128) throw new Error("SkillHub evaluation worker ID must contain 1 to 128 characters")
}

function requireClaimLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumClaimLimit)
    throw new Error(`SkillHub evaluation claim limit must be between 1 and ${maximumClaimLimit}`)
}

function requireLeaseMilliseconds(leaseMilliseconds: number) {
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1 || leaseMilliseconds > 86_400_000)
    throw new Error("SkillHub evaluation lease must be between 1 millisecond and 24 hours")
}

function requireRetryPolicy(maximumAttempts: number, baseDelayMilliseconds: number, maximumDelayMilliseconds: number) {
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 100)
    throw new Error("SkillHub evaluation maximum attempts must be between 1 and 100")
  if (!Number.isSafeInteger(baseDelayMilliseconds) || baseDelayMilliseconds < 1 || baseDelayMilliseconds > 86_400_000)
    throw new Error("SkillHub evaluation base retry delay must be between 1 millisecond and 24 hours")
  if (!Number.isSafeInteger(maximumDelayMilliseconds) || maximumDelayMilliseconds < baseDelayMilliseconds || maximumDelayMilliseconds > 86_400_000)
    throw new Error("SkillHub evaluation maximum retry delay must be between the base delay and 24 hours")
}

function boundedSummary(summary: string) {
  return summary.slice(0, 500) || "Unclassified SkillHub evaluation error"
}

function readProgress(connection: Database, timestamp: number) {
  const counts = connection
    .query<EvaluationCountRow, []>(
      "SELECT evaluation_state, COUNT(*) AS count FROM skillhub_import_items WHERE state = 'mirrored' GROUP BY evaluation_state",
    )
    .all()
  const count = (state: string) => counts.find((row) => row.evaluation_state === state)?.count ?? 0
  const total = counts.reduce((result, row) => result + row.count, 0)
  const remaining = count("waiting") + count("pending") + count("running") + count("retry_wait")
  const ratePerMinute = connection
    .query<{ readonly count: number }, [number]>(
      "SELECT COUNT(*) AS count FROM skillhub_import_items WHERE state = 'mirrored' AND evaluation_state = 'completed' AND evaluation_checked_at > ?",
    )
    .get(timestamp - 60_000)!.count
  const recentError = connection
    .query<{ readonly evaluation_error_summary: string }, []>(
      "SELECT evaluation_error_summary FROM skillhub_import_items WHERE state = 'mirrored' AND evaluation_error_summary IS NOT NULL ORDER BY updated_at DESC, slug DESC LIMIT 1",
    )
    .get()?.evaluation_error_summary
  const estimatedSecondsRemaining = ratePerMinute === 0 ? undefined : Math.ceil((remaining / ratePerMinute) * 60)
  return Schema.decodeUnknownSync(SkillMarketControl.SkillHubEvaluationProgress)({
    total,
    waiting: count("waiting"),
    pending: count("pending"),
    running: count("running"),
    retryWait: count("retry_wait"),
    completed: count("completed"),
    failed: count("failed"),
    ratePerMinute,
    ...(estimatedSecondsRemaining === undefined ? {} : { estimatedSecondsRemaining }),
    ...(recentError === undefined ? {} : { recentError }),
  })
}

function iso(timestamp: number) {
  return new Date(timestamp).toISOString()
}
