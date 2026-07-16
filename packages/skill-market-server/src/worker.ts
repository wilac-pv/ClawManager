import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Option, Schema } from "effect"
import { loadConfig } from "./config"
import type { MarketDatabase } from "./database"
import { openDatabase } from "./database"
import { emitMarketMetric, type MarketMetricEmitter } from "./metrics"
import { makeS3ObjectStore, type PrivateObjectStore } from "./oss"
import type { Publisher } from "./publisher"
import { createPublisher } from "./publisher"
import { SkillMarketSecurityError } from "./security"
import {
  persistQuarantinedValidation,
  type ReceivedSubmission,
  validateQuarantinedSubmission,
} from "./submission-archive"
import type { Submissions } from "./submissions"
import { createSubmissions } from "./submissions"

interface WorkerOptions {
  readonly database: MarketDatabase
  readonly submissions: Submissions
  readonly store: PrivateObjectStore
  readonly publisher?: Pick<Publisher, "runOne">
  readonly leaseMilliseconds?: number
  readonly now?: () => number
  readonly emit?: MarketMetricEmitter
  readonly sessionIdleMilliseconds?: number
}

interface ValidationRow {
  readonly submission_id: string
  readonly revision_number: number
  readonly skill_id: string
  readonly private_package_key: string
  readonly package_sha256: string
  readonly package_size: number
  readonly metadata_json: string
  readonly private_icon_json: string | null
}

const StoredIcon = Schema.Struct({
  key: Schema.String,
  sha256: Schema.String,
  size: Schema.Number,
  mime: Schema.String,
})

export class Worker {
  private wakePromise: Promise<void> | undefined

  constructor(private readonly options: WorkerOptions) {}

  async runOne(workerID: string) {
    requireWorkerID(workerID)
    const validation = this.claimValidation(workerID)
    if (validation) return this.validate(workerID, validation)
    if (!this.options.publisher) return undefined
    const started = performance.now()
    const published = await settled(this.options.publisher.runOne(workerID))
    if (!published.ok) {
      this.emit({
        skill_market_publish_duration_ms: Math.round(performance.now() - started),
        skill_market_publish_result: { retry: 1 },
      })
      return { kind: "publication" as const, result: "retry" as const }
    }
    if (!published.value) return undefined
    this.emit({
      skill_market_publish_duration_ms: Math.round(performance.now() - started),
      skill_market_publish_result: { success: 1 },
    })
    return { kind: "publication" as const, result: "success" as const }
  }

  async drain(workerID: string): Promise<void> {
    const result = await this.runOne(workerID)
    if (!result || result.result === "retry") return
    return this.drain(workerID)
  }

  wake(workerID: string) {
    if (this.wakePromise) return this.wakePromise
    const active = this.drain(workerID).finally(() => {
      if (this.wakePromise === active) this.wakePromise = undefined
    })
    this.wakePromise = active
    return active
  }

  cleanup() {
    const now = this.now()
    const result = this.options.database.transaction((connection) => ({
      loginAttempts: connection.run("DELETE FROM login_attempts WHERE expires_at <= ?", [now]).changes,
      sessions: connection.run("DELETE FROM sessions WHERE absolute_expires_at <= ? OR last_activity_at <= ?", [
        now,
        now - (this.options.sessionIdleMilliseconds ?? 2 * 60 * 60 * 1_000),
      ]).changes,
      idempotencyKeys: connection.run("DELETE FROM idempotency_keys WHERE expires_at <= ?", [now]).changes,
    }))
    this.emit({ skill_market_cleanup_result: result })
    return result
  }

  private claimValidation(workerID: string) {
    const now = this.now()
    return this.options.database.transaction((connection) => {
      const candidate = connection
        .query<ValidationRow, [number]>(
          `${validationSelect()}
           WHERE submissions.status = 'validating'
             AND submissions.current_revision = submission_revisions.revision_number
             AND submission_revisions.validation_completed_at IS NULL
             AND (
               submission_revisions.validation_lease_owner IS NULL OR
               submission_revisions.validation_lease_expires_at <= ?
             )
           ORDER BY submission_revisions.created_at, submissions.id
           LIMIT 1`,
        )
        .get(now)
      if (!candidate) return undefined
      const claimed = connection.run(
        `UPDATE submission_revisions
         SET validation_lease_owner = ?, validation_lease_expires_at = ?
         WHERE submission_id = ? AND revision_number = ?
           AND validation_completed_at IS NULL
           AND (validation_lease_owner IS NULL OR validation_lease_expires_at <= ?)`,
        [
          workerID,
          now + (this.options.leaseMilliseconds ?? 5 * 60 * 1_000),
          candidate.submission_id,
          candidate.revision_number,
          now,
        ],
      ).changes
      return claimed === 1 ? candidate : undefined
    })
  }

  private async validate(workerID: string, row: ValidationRow) {
    const started = performance.now()
    const body = await settled(this.options.store.get(row.private_package_key))
    if (!body.ok) {
      this.release(workerID, row)
      this.emitValidation(started, "retry")
      return { kind: "validation" as const, result: "retry" as const }
    }
    const received = receivedSubmission(row)
    const validation = await settled(
      validateQuarantinedSubmission(received, this.options.store, () => this.now(), {
        body: body.value,
        persist: false,
      }),
    )
    if (!validation.ok) {
      const completed = await settled(
        Promise.resolve().then(() =>
          this.options.submissions.completeValidation({
            submissionID: row.submission_id,
            revision: row.revision_number,
            manifest: {
              packageSha256: row.package_sha256,
              packageSize: row.package_size,
              files: [],
            },
            scan: {
              risk: "unknown",
              reasons: ["Archive validation failed"],
              evidence: [],
              scannedAt: new Date(this.now()).toISOString(),
            },
            validationIssues: [{ code: "archive-invalid", message: "Skill archive validation failed" }],
          }),
        ),
      )
      if (!completed.ok) this.release(workerID, row)
      const result = completed.ok ? "failure" : completionResult(completed.error)
      this.emitValidation(started, result)
      return { kind: "validation" as const, result }
    }
    const persisted = await settled(persistQuarantinedValidation(received, this.options.store, validation.value))
    if (!persisted.ok) {
      this.release(workerID, row)
      this.emitValidation(started, "retry")
      return { kind: "validation" as const, result: "retry" as const }
    }
    const issues = [
      ...validation.value.validationIssues,
      ...(validation.value.skillID === row.skill_id
        ? []
        : [{ code: "skill-id-mismatch", message: "SKILL.md name does not match the submitted Skill ID" }]),
    ]
    const completed = await settled(
      Promise.resolve().then(() =>
        this.options.submissions.completeValidation({
          submissionID: row.submission_id,
          revision: row.revision_number,
          manifest: validation.value.manifest,
          scan: validation.value.scan,
          validationIssues: issues,
        }),
      ),
    )
    if (!completed.ok) this.release(workerID, row)
    const result = completed.ok ? (issues.length > 0 ? "failure" : "success") : completionResult(completed.error)
    this.emitValidation(started, result)
    return { kind: "validation" as const, result }
  }

  private release(workerID: string, row: ValidationRow) {
    this.options.database.transaction((connection) =>
      connection.run(
        `UPDATE submission_revisions
         SET validation_lease_owner = NULL, validation_lease_expires_at = NULL
         WHERE submission_id = ? AND revision_number = ?
           AND validation_completed_at IS NULL AND validation_lease_owner = ?`,
        [row.submission_id, row.revision_number, workerID],
      ),
    )
  }

  private emitValidation(started: number, result: "success" | "failure" | "retry" | "stale") {
    this.emit({
      skill_market_validation_duration_ms: Math.round(performance.now() - started),
      skill_market_validation_result: { [result]: 1 },
    })
  }

  private emit(metric: Readonly<Record<string, unknown>>) {
    const emit = this.options.emit ?? emitMarketMetric
    emit(metric)
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }
}

export function createWorker(options: WorkerOptions) {
  return new Worker(options)
}

function receivedSubmission(row: ValidationRow): ReceivedSubmission {
  return {
    metadata: decodeJson(SkillMarketControl.SubmissionMetadata, row.metadata_json),
    package: {
      key: row.private_package_key,
      sha256: row.package_sha256,
      size: row.package_size,
    },
    ...(row.private_icon_json ? { icon: decodeJson(StoredIcon, row.private_icon_json) } : {}),
  }
}

function validationSelect() {
  return `SELECT
    submissions.id AS submission_id,
    submission_revisions.revision_number,
    submissions.skill_id,
    submission_revisions.private_package_key,
    submission_revisions.package_sha256,
    submission_revisions.package_size,
    submission_revisions.metadata_json,
    submission_revisions.private_icon_json
   FROM submission_revisions
   INNER JOIN submissions ON submissions.id = submission_revisions.submission_id`
}

function completionResult(error: unknown): "retry" | "stale" {
  if (error instanceof SkillMarketSecurityError && (error.code === "not-found" || error.code === "submission-conflict"))
    return "stale"
  return "retry"
}

function decodeJson<S extends Schema.Decoder<unknown>>(schema: S, value: string): S["Type"] {
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value)
  if (Option.isNone(json)) throw new Error("validation work JSON is invalid")
  return Schema.decodeUnknownSync(schema)(json.value)
}

function requireWorkerID(value: string) {
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) return value
  throw new Error("worker ID is invalid")
}

async function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  )
}

async function production() {
  if (!process.argv.includes("--once")) throw new Error("worker requires --once")
  const config = loadConfig()
  const store = makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket })
  const database = await openDatabase({
    databasePath: config.databasePath,
    migrationBackupDirectory: config.migrationBackupDirectory,
    emit: emitMarketMetric,
  })
  const worker = createWorker({
    database,
    submissions: createSubmissions({ database }),
    store,
    publisher: createPublisher({
      database,
      store,
      ossPrefix: config.ossPrefix,
      publicBaseUrl: config.publicBaseUrl,
      webBaseUrl: config.webBaseUrl,
    }),
    emit: emitMarketMetric,
    sessionIdleMilliseconds: config.sessionIdleMilliseconds,
  })
  worker.cleanup()
  await worker.drain("worker-once").finally(() => database.close())
}

if (import.meta.main) await production()
