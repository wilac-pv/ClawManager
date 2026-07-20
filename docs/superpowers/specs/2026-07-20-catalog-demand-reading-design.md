# Catalog Demand Reading Design

## Context

The production catalog contains about 77,000 summaries. Release
`4e0cdb2a7233409a7f8f0b05b4439c3c582894d0` replaced the prior demand-oriented
catalog reader with `loadCurrentSnapshot(...)`. Every public catalog operation
therefore downloads and decodes every detail object before it can return.

A production smoke request to `GET /v1/catalog/skills` raised the API process
from about 110 MiB to 6.4 GiB RSS, saturated one CPU, blocked `/health`, and
raised full IO pressure. The release was rolled back to
`3bd6f43eb52872b2adb5b9f9cae30ddef3fb15de`.

## Goals

- List and facet requests read only the pointer, catalog index, and facets.
- Detail, version, download metadata, and package requests read one detail.
- Preserve V1 and content-addressed V2 snapshot compatibility.
- Preserve revision validation, detail hash validation, source freshness
  headers, filtering, sorting, CORS, and bounded error responses.
- Keep synchronization and publication behavior unchanged.

## Non-goals

- Do not cache the complete detail set in the API process.
- Do not proxy unvalidated OSS JSON directly to clients.
- Do not change the public Protocol or generated client.
- Do not change synchronization frequency or catalog publication layout.

## Design

Reintroduce a focused `CatalogReader` boundary backed by the existing
`ObjectStore`.

The reader exposes:

- `index()` for the validated pointer, catalog summaries, facets, revision, and
  source status;
- `list(query)` for query execution against cached summaries;
- `facets()` for the current validated facets;
- `detail(source, id)` for one validated detail object.

The reader caches only the current index promise. Concurrent requests for the
same revision share that promise. A pointer change replaces the cached index.
No method retains the complete detail collection.

For V1 snapshots, `detail(source, id)` reads the legacy revision-scoped detail
key. For V2 snapshots, the index supplies the content-addressed detail key and
SHA-256. The reader rejects a key that does not match
`details/<sha256>.json`, verifies the downloaded bytes against that hash, and
then decodes `SkillMarket.Detail`.

`createCatalogHttp(...)` consumes the reader. List and facets call only index
methods. Detail, versions, and download metadata call `detail(...)`. Package
delivery first loads the single detail through the same reader and then keeps
the existing trusted package verification path.

`server.ts` constructs one reader for the process and injects it into the HTTP
routes. Synchronization continues to use `loadCurrentSnapshot(...)`, because a
full validated snapshot is required when merging and publishing sources.

## Error handling and observability

Pointer, index, facet, detail, key, hash, or schema failures continue to map to
the existing bounded `503` or package problem responses. Responses must not
expose OSS keys, dependency bodies, stack traces, or credentials.

The production smoke gate remains:

- `GET`, `HEAD`, and `OPTIONS /v1/catalog/skills` return 2xx with wildcard CORS;
- `/health` stays responsive during and after the request;
- the API process does not perform detail-object reads for a list request.

## Testing

Add reader tests for V1 and V2 snapshots, pointer changes, single-detail reads,
content-addressed hash validation, and index promise reuse.

Update HTTP tests to inject a `CatalogReader` and assert:

- list and facets do not call `detail(...)`;
- detail, versions, download metadata, GET package, and HEAD package load only
  the requested detail;
- existing unavailable, delisted, traversal, size, and hash failures remain
  bounded.

Run the package test suite and `bun typecheck` from
`packages/skill-market-server`. Build an immutable release, deploy with the
existing backup and rollback runbook, run smoke and private canary checks, then
sample RSS, CPU, IO pressure, health latency, and catalog response time before
enabling the formal sync timer.
