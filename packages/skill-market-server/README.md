# Ruying Skill Market Server

This package synchronizes the public SkillHub catalog and the Ruying enterprise index into immutable OSS snapshots, then serves the current validated revision through a read-only HTTP API.

## Commands

Run commands from this package directory:

```bash
bun run sync
bun run start
bun test
bun typecheck
```

`sync` is a one-shot operation. Production scheduling should invoke it every two minutes; successful SkillHub data is reused for ten minutes while the enterprise index is checked with its ETag on every run.

Example cron entry:

```cron
*/2 * * * * cd /srv/ruying-code/packages/skill-market-server && /usr/local/bin/bun run sync
```

Do not run overlapping sync jobs. Use the scheduler's single-instance or lock option.

## Configuration

| Variable                            | Required            | Default                              | Purpose                                                                          |
| ----------------------------------- | ------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `SKILL_MARKET_PORT`                 | No                  | `4210`                               | Public HTTP listen port.                                                         |
| `SKILLHUB_BASE_URL`                 | No                  | `https://api.skillhub.cn`            | SkillHub API base URL.                                                           |
| `SKILL_MARKET_ENTERPRISE_INDEX_URL` | Yes                 | —                                    | HTTPS enterprise index URL.                                                      |
| `SKILL_MARKET_OSS_ENDPOINT`         | Yes                 | —                                    | HTTPS S3-compatible OSS endpoint.                                                |
| `SKILL_MARKET_OSS_REGION`           | No                  | `cn-baoding`                         | S3 signing region.                                                               |
| `SKILL_MARKET_OSS_BUCKET`           | No                  | `app-platform`                       | OSS bucket.                                                                      |
| `SKILL_MARKET_OSS_PREFIX`           | No                  | `ai-coding/ruying-code/skill-market` | Object key prefix.                                                               |
| `SKILL_MARKET_PUBLIC_BASE_URL`      | Yes                 | —                                    | Public URL corresponding to the configured OSS prefix; include a trailing slash. |
| `SKILL_MARKET_ALLOWED_HOSTS`        | No                  | `api.skillhub.cn`                    | Comma-separated redirect/package/icon allowlist.                                 |
| `AWS_ACCESS_KEY_ID`                 | Deployment-specific | —                                    | S3-compatible access key.                                                        |
| `AWS_SECRET_ACCESS_KEY`             | Deployment-specific | —                                    | S3-compatible secret.                                                            |
| `AWS_SESSION_TOKEN`                 | No                  | —                                    | Temporary credential token.                                                      |

`SKILL_MARKET_ALLOWED_HOSTS` must include the SkillHub API host, its current package download host, the enterprise index/package hosts, and any mirrored icon hosts. Every URL is required to use HTTPS without embedded credentials.

## HTTP API and probes

- `GET /health` returns process health without loading OSS catalog state.
- `GET /v1/catalog/skills` lists the current revision.
- `GET /v1/catalog/facets` returns filter counts.
- `GET /v1/catalog/skills/:source/:id` returns a verified detail.
- `GET /v1/catalog/skills/:source/:id/versions` returns verified versions.
- `GET /v1/catalog/skills/:source/:id/download` returns only the mirrored URL, SHA-256 and size from that detail.

`HEAD` is supported for read routes. `OPTIONS` returns CORS preflight without loading catalog state. Public responses use `Access-Control-Allow-Origin: *` and never enable credentials. Catalog responses expose `x-skill-market-revision`, `x-skill-market-source-skillhub`, and `x-skill-market-source-enterprise`.

The health probe verifies only that the process can respond. Use a list request as a readiness probe when OSS availability must be included.

## Safety and publication

Package downloads follow at most five redirects and every hop must remain in the configured allowlist. Synchronization enforces a 50 MiB compressed limit, 100 MiB expanded limit, 1,000-file limit, SHA-256 verification, safe relative ZIP paths, no encryption, no ZIP64, no symlinks, matching SkillHub file manifests, and a valid root `SKILL.md`.

Catalog, facets, details, packages, and icons use immutable revision/content keys. `current.json` is replaced only after every catalog object can be read back and decoded with the public schemas.

## Metrics and logs

Production log collection should extract these stable metric names:

- `skill_market_sync_duration_ms`
- `skill_market_source_success`
- `skill_market_catalog_count`
- `skill_market_cache_hit`
- `skill_market_download_result`

The one-shot sync emits duration, source success, and catalog count as JSON. The serving and desktop layers should attach cache-hit and download-result counters to the same metric namespace.

## Rollback

Retain previous `indexes/<revision>` objects. Before rollback:

1. Read and Schema-validate the target revision's `catalog.json` and `facets.json`.
2. Verify every catalog item has a decodable detail under `details/<source>/<encoded-id>.json`.
3. Verify every detail references an existing immutable package and that its size and SHA-256 match.
4. Overwrite only `<prefix>/current.json` with the retained revision and its original `createdAt`.
5. Confirm a list and detail request return the retained `x-skill-market-revision`.

Never copy old objects over a newer immutable revision and never delete the current revision during rollback.
