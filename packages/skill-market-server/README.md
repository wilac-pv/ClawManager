# Ruying Skill Market Server

This package serves the public Skill Market catalog, authenticates contributors with Ruying SSO, accepts quarantined Skill submissions, supports reviewer/admin moderation, and publishes approved community Skills into immutable OSS catalog revisions.

SQLite is the durable control-plane source of truth. Process-local worker wakeups only reduce latency: after a restart, `start`, `sync`, or `worker --once` discovers eligible validation and publication work from SQLite and resumes it with bounded leases.

## Commands

Run commands from this package directory:

```bash
bun run start
bun run worker --once
bun run sync
bun test
bun typecheck
```

- `start` runs the HTTP API. Before reporting ready, it cleans expired ephemeral rows and drains recoverable validation/publication work.
- `worker --once` performs cleanup and drains validation jobs followed by publication jobs, then exits. The `--once` flag is mandatory.
- `sync` first drains recoverable control-plane work, then synchronizes SkillHub, enterprise, and community sources under the shared catalog publication lease.
- `skillhub-worker` discovers and mirrors SkillHub incrementally, then publishes a fresh mirror under its independent systemd lock. It is intended to run every minute.
- `evaluation-worker` fills missing SkillHub TRACE scores under its own one-minute systemd timer. It is bounded to 50 seconds and uses a dedicated lock so an overlapping run exits without doing work.
- `sync` is intended to run every two minutes. Successful SkillHub data is reused for ten minutes while the enterprise index is checked with its ETag on every run.

Example cron entries:

```cron
* * * * * cd /srv/ruying-code/packages/skill-market-server && /usr/local/bin/bun run worker --once
*/2 * * * * cd /srv/ruying-code/packages/skill-market-server && /usr/local/bin/bun run sync
```

Leases make a later invocation safe after a crashed process. Avoid intentionally overlapping `sync` invocations; the shared publication lease will reject a conflicting catalog writer.

## Configuration

| Variable                                    | Required            | Default                                       | Purpose                                                                                                    |
| ------------------------------------------- | ------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `SKILL_MARKET_PORT`                         | No                  | `4210`                                        | HTTP listen port.                                                                                          |
| `SKILL_MARKET_DATABASE_PATH`                | No                  | `/var/lib/ruying-skill-market/market.db`      | SQLite database path. The file is set to mode `0600`.                                                      |
| `SKILL_MARKET_MIGRATION_BACKUP_DIRECTORY`   | No                  | `/var/backups/ruying-skill-market/migrations` | Directory for verified pre-migration SQLite backups.                                                       |
| `SKILLHUB_BASE_URL`                         | No                  | `https://api.skillhub.cn`                     | SkillHub API base URL.                                                                                     |
| `SKILL_MARKET_SKILLHUB_LIMIT`               | Emergency canary only | omitted in production full mirror             | Set only to `30` for a short controlled canary; remove it before a production full mirror.                |
| `SKILL_MARKET_SKILLHUB_PAGE_CONCURRENCY`    | No                  | `4`                                           | Concurrent SkillHub page requests; maximum `16`.                                                          |
| `SKILL_MARKET_SKILLHUB_METADATA_CONCURRENCY`| No                  | `8`                                           | Concurrent SkillHub metadata requests; maximum `32`.                                                       |
| `SKILL_MARKET_SKILLHUB_PACKAGE_CONCURRENCY` | No                  | `6`                                           | Concurrent SkillHub package transfers; maximum `12`.                                                       |
| `SKILL_MARKET_SKILLHUB_PUBLISH_BATCH`       | No                  | `2000`                                        | Mirrored records accumulated before a publication; positive integer.                                      |
| `SKILL_MARKET_SKILLHUB_PUBLISH_MINUTES`     | No                  | `30`                                          | Maximum delay before publishing accumulated records; positive integer.                                     |
| `SKILL_MARKET_SKILLHUB_MEMORY_SOFT_LIMIT_MB`| No                  | `1536`                                        | Mirror memory soft limit in MiB; minimum `512`.                                                            |
| `SKILL_MARKET_EVALUATION_CONCURRENCY`      | No                  | `2`                                           | Concurrent TRACE evaluation fetches; maximum `2`.                                                          |
| `SKILL_MARKET_EVALUATION_REQUESTS_PER_MINUTE` | No                | `60`                                          | TRACE request-start ceiling across the worker.                                                              |
| `SKILL_MARKET_EVALUATION_REFRESH_DAYS`     | No                  | `7`                                           | Re-evaluate a successful TRACE score after this many days.                                                 |
| `SKILL_MARKET_EVALUATION_PUBLISH_BATCH`    | No                  | `100`                                         | Completed TRACE scores accumulated before publishing; range `1..100`.                                       |
| `SKILL_MARKET_ENTERPRISE_INDEX_URL`         | Yes                 | —                                             | HTTPS enterprise catalog index URL.                                                                        |
| `SKILL_MARKET_OSS_ENDPOINT`                 | Yes                 | —                                             | HTTPS S3-compatible OSS endpoint.                                                                          |
| `SKILL_MARKET_OSS_REGION`                   | No                  | `cn-baoding`                                  | S3 signing region.                                                                                         |
| `SKILL_MARKET_OSS_BUCKET`                   | No                  | `app-platform`                                | OSS bucket name.                                                                                           |
| `SKILL_MARKET_OSS_PREFIX`                   | No                  | `ai-coding/ruying-code/skill-market`          | Public catalog and immutable object prefix.                                                                |
| `SKILL_MARKET_PRIVATE_OSS_PREFIX`           | No                  | `ai-coding/ruying-code/skill-market-private`  | Private quarantine prefix for uploads and validation artifacts. It must not overlap the public prefix.     |
| `SKILL_MARKET_PUBLIC_BASE_URL`              | Yes                 | —                                             | Public HTTPS URL mapped to the public OSS prefix.                                                          |
| `SKILL_MARKET_WEB_ORIGIN`                   | No                  | `http://127.0.0.1:4211`                       | Exact browser origin allowed to call credentialed control APIs and used for public community detail links. |
| `SKILL_MARKET_API_PUBLIC_URL`               | No                  | `http://127.0.0.1:<port>`                     | Externally reachable API origin used in SSO callback URLs and Cookie policy.                               |
| `SKILL_MARKET_SSO_LOGIN_URL`                | No                  | `https://sso.gwm.cn/login`                    | Ruying SSO authorization entry URL.                                                                        |
| `SKILL_MARKET_ADMIN_API_BASE_URL`           | No                  | `https://aicoding-admin.gwm.cn`               | HTTPS API used to resolve the authenticated employee profile.                                              |
| `SKILL_MARKET_ALLOW_INSECURE_IP_HTTP`       | No                  | `false`                                       | Allows HTTP only for private-IPv4 test origins. It does not permit public HTTP hosts.                      |
| `SKILL_MARKET_LOGIN_ATTEMPT_MINUTES`        | No                  | `5`                                           | SSO login-attempt lifetime.                                                                                |
| `SKILL_MARKET_SESSION_IDLE_MINUTES`         | No                  | `120`                                         | Session idle timeout.                                                                                      |
| `SKILL_MARKET_SESSION_ABSOLUTE_MINUTES`     | No                  | `720`                                         | Absolute session lifetime; it must be at least the idle timeout.                                           |
| `SKILL_MARKET_DAILY_UPLOAD_LIMIT`           | No                  | `20`                                          | Per-user successful upload allowance per rolling day.                                                      |
| `SKILL_MARKET_ACTIVE_SUBMISSION_LIMIT`      | No                  | `5`                                           | Maximum active submissions owned by one user.                                                              |
| `SKILL_MARKET_BOOTSTRAP_ADMIN_EMPLOYEE_IDS` | Initial deployment  | empty                                         | Comma-separated employee IDs granted the admin role idempotently at startup.                               |
| `SKILL_MARKET_ALLOWED_HOSTS`                | No                  | SkillHub API and icon CDN hosts               | Comma-separated allowlist for every upstream API, redirect, package, enterprise index, and icon host.      |
| `AWS_ACCESS_KEY_ID`                         | Deployment-specific | —                                             | S3-compatible access key.                                                                                  |
| `AWS_SECRET_ACCESS_KEY`                     | Deployment-specific | —                                             | S3-compatible secret key.                                                                                  |
| `AWS_SESSION_TOKEN`                         | No                  | —                                             | Temporary credential token when applicable.                                                                |

All upstream and OSS URLs must use HTTPS without embedded credentials. Production control origins must also use HTTPS. With HTTPS, the session Cookie is host-only, `Secure`, `HttpOnly`, `SameSite=Lax`, and uses the `__Host-` prefix. Private-IP HTTP mode produces a non-Secure test Cookie and must not be used as a production deployment mode.

## Scoped sharing operations

All non-personal submissions, including company, department, and group scopes, require an independent Reviewer or Admin approval. Reviewers must not approve their own submissions. Moderation displays the resolved department name/ID or group IDs, never private package keys.

| Audience | Anonymous | Authorized employee | Outsider |
| --- | --- | --- | --- |
| Company | Catalog and detail | Catalog and detail | Catalog and detail |
| Department | No restricted record | List, detail, versions, 10-minute install grant, download | `404` |
| Group | No restricted record | List, detail, versions, 10-minute install grant, download | `404` |

Restricted grants store only token hashes, expire after ten minutes, and access is re-evaluated for every detail, version, grant, and download request. Disabling a group, removing a member, or moving a user between departments revokes access immediately. Return `404` for unauthenticated and unauthorized restricted requests to prevent enumeration. Do not log grant tokens or hashes, private package keys, authorization headers, or cookies.

Restricted records use `/v1/restricted-skills/*` only; generic public catalog routes reject the `restricted` source. Every restricted response, including denial and `404`, must use `Cache-Control: no-store`. Public company catalog responses retain their normal public caching policy. Keep public and private OSS prefixes disjoint.

Migration `011_scoped_sharing.sql` is a single not-yet-deployed compatibility batch. Before applying it, create and verify an encrypted private backup; its verifier checks all migration-011 scoped tables, review artifact snapshot columns, indexes, and triggers. Roll back by restoring the verified backup before re-enabling traffic; use the scoped-sharing feature flags to keep group/department publishing disabled until the controlled validation succeeds. Deploy the coordinated audit enum with this batch, never independently.

The OSS identity needs read/write access to both configured prefixes. Only `SKILL_MARKET_OSS_PREFIX` should be publicly readable; quarantine objects under `SKILL_MARKET_PRIVATE_OSS_PREFIX` must remain private.

Redacted example:

```dotenv
SKILL_MARKET_PORT=4210
SKILL_MARKET_DATABASE_PATH=/var/lib/ruying-skill-market/market.db
SKILL_MARKET_MIGRATION_BACKUP_DIRECTORY=/var/backups/ruying-skill-market/migrations
SKILL_MARKET_ENTERPRISE_INDEX_URL=https://oss.example.internal/catalog/enterprise.json
SKILL_MARKET_OSS_ENDPOINT=https://oss.example.internal
SKILL_MARKET_OSS_REGION=cn-baoding
SKILL_MARKET_OSS_BUCKET=example-bucket
SKILL_MARKET_OSS_PREFIX=ai-coding/ruying-code/skill-market
SKILL_MARKET_PRIVATE_OSS_PREFIX=ai-coding/ruying-code/skill-market-private
SKILL_MARKET_PUBLIC_BASE_URL=https://downloads.example.internal/ai-coding/ruying-code/skill-market/
SKILL_MARKET_WEB_ORIGIN=https://skills.example.internal
SKILL_MARKET_API_PUBLIC_URL=https://skills-api.example.internal
SKILL_MARKET_SSO_LOGIN_URL=https://sso.example.internal/login
SKILL_MARKET_ADMIN_API_BASE_URL=https://admin-api.example.internal
SKILL_MARKET_EVALUATION_CONCURRENCY=2
SKILL_MARKET_EVALUATION_REQUESTS_PER_MINUTE=60
SKILL_MARKET_EVALUATION_REFRESH_DAYS=7
SKILL_MARKET_EVALUATION_PUBLISH_BATCH=100
SKILL_MARKET_BOOTSTRAP_ADMIN_EMPLOYEE_IDS=E000001
SKILL_MARKET_ALLOWED_HOSTS=api.skillhub.cn,cloudcache.tencent-cloud.com,docs.cloudbase.net,skillhub-1388575217.cos.accelerate.myqcloud.com,oss.example.internal,packages.example.internal
AWS_ACCESS_KEY_ID=REDACTED
AWS_SECRET_ACCESS_KEY=REDACTED
```

The `SKILL_MARKET_EVALUATION_*` names are canonical. Existing
`SKILL_MARKET_SKILLHUB_EVALUATION_*` names remain supported for a rolling
deployment upgrade, but canonical values take precedence when both are set.

## HTTP API

Public catalog routes allow wildcard read-only CORS:

- `GET /health`
- `GET /v1/catalog/skills`
- `GET /v1/catalog/facets`
- `GET /v1/catalog/skills/:source/:id`
- `GET /v1/catalog/skills/:source/:id/versions`
- `GET /v1/catalog/skills/:source/:id/download`

Credentialed control routes allow only the exact configured web origin:

- `/v1/auth/login`, `/v1/auth/callback/:attemptID`, `/v1/auth/session`
- `/v1/submissions` and `/v1/submissions/:submissionID/revisions`
- `/v1/admin/submissions`, `/v1/admin/roles`, `/v1/admin/audit`
- `/v1/admin/community-skills/:skillID/delist` and `/restore`

Mutation requests require the session Cookie, the CSRF Cookie value in `X-CSRF-Token`, and the exact `Origin`. Uploads use streaming `multipart/form-data` and require an `Idempotency-Key`; request bodies are quarantined before durable admission.

Catalog responses expose `x-skill-market-revision` and source health for SkillHub, enterprise, and community. `HEAD` is supported for public reads, and `OPTIONS` returns CORS preflight without loading catalog state.

## Validation, publication, and recovery

User archives remain private until approved. Validation enforces compressed/expanded/file-count and compression-ratio limits, safe relative ZIP paths, no encryption, no ZIP64, no symlinks, a valid root `SKILL.md`, bounded metadata, content scanning, and package identity checks. Validation never evaluates uploaded code.

Publication follows this order:

```text
lease job -> verify quarantine -> copy immutable package -> build and validate snapshot
-> write immutable snapshot -> persist target revision -> update current.json
-> finalize SQLite state and audit event
```

Expired leases are reclaimable. If `current.json` moved before SQLite finalization, recovery recognizes the persisted target revision and completes SQLite exactly once without moving the pointer again.

TRACE evaluation publication is a bounded delta update. If a service timeout or
memory guard fires before a catalog target revision is persisted, completed
evaluation rows remain retryable and the transient catalog job is retired. If a
target revision was persisted, lease-expiry recovery compares `current.json` and
finalizes only a matching pointer outcome; a mismatch retires the delta job and
the completed evaluation rows become the retry source. Following an abnormal
memory or IO event, operators must keep the evaluation and general publication
timers disabled until one manual bounded evaluation run passes its memory, swap,
IO-wait, and target-less-job checks.

Database migrations are contiguous and transactional. When an existing database needs a migration, startup first writes a timestamped mode-`0600` backup, removes WAL sidecars, and verifies `PRAGMA integrity_check`. A failed migration leaves the prior schema/data intact. Monitor backup metrics and copy the backup directory to the deployment backup system according to the service retention policy.

Cleanup removes expired login attempts, sessions, and idempotency records. Run `worker --once` regularly even when the HTTP server is not continuously active.

## Metrics and logs

Production log collection should extract these JSON metric names:

- `skill_market_sync_duration_ms`
- `skill_market_source_success`
- `skill_market_catalog_count`
- `skill_market_upload_count`
- `skill_market_validation_duration_ms`
- `skill_market_validation_result`
- `skill_market_review_wait_ms`
- `skill_market_review_decision`
- `skill_market_publish_duration_ms`
- `skill_market_publish_result`
- `skill_market_sso_result`
- `skill_market_session_rejection`
- `skill_market_role_rejection`
- `skill_market_cleanup_result`
- `skill_market_database_backup_result`

Metric records contain bounded outcomes, counters, and durations only. Do not add employee IDs, names, object paths, content, hashes, tokens, or error messages as labels.

## Rollback

Retain previous `indexes/<revision>` objects. Before rollback:

1. Read and schema-validate the target revision's `catalog.json` and `facets.json`.
2. Verify every catalog item has a decodable detail under `details/<source>/<encoded-id>.json`.
3. Verify every detail references an existing immutable package with the expected size and SHA-256.
4. Overwrite only `<public-prefix>/current.json` with the retained revision and its original `createdAt`.
5. Confirm list and detail requests return the retained `x-skill-market-revision`.

Never overwrite immutable revision objects or delete the currently referenced revision during rollback.
