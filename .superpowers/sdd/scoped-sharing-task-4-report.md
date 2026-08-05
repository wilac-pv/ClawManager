# Scoped Sharing Task 4 report

## Status

Complete. Authorized restricted publications now merge into optional-session catalog reads, direct restricted reads use the same live audience policy, and package delivery uses hashed ten-minute install grants with authorization rechecked on both HEAD and GET.

## Commit

- `feat(skill-market): authorize restricted catalog` (this report is included in the commit; the final task result records its hash)

## TDD evidence

- Baseline: `bun test test/catalog-reader.test.ts test/control-http.test.ts` — 37 passed, 0 failed.
- Initial RED: focused server suite — 41 passed, 3 failed, 1 error (missing restricted catalog/grant implementation and migration).
- Protocol RED: 0 passed, 3 failed for the absent direct-read operations and server API composition.
- HTTP RED: authenticated catalog response remained public and omitted authorized restricted publications.
- Final focused server verification: 41 passed, 0 failed; `bun typecheck` passed.
- Database/auth/security/legacy HTTP regression verification: 43 passed, 0 failed.
- Schema verification: 22 passed, 0 failed; `bun typecheck` passed.
- Protocol verification: 14 passed, 0 failed; `bun typecheck` passed.
- Client verification: 5 passed, 0 failed; `bun typecheck` passed; generated sources were regenerated from the Protocol API.

## Implementation

- Centralized the live restricted-read SQL predicate for owner, current admin, current department, and current membership in active groups.
- Added restricted summary, detail, and version projections without exposing private object keys or permanent package URLs.
- Merged authorized restricted summaries before filtering, sorting, pagination, facets, and deterministic revision calculation. Anonymous and invalid-session reads remain public-only and publicly cacheable; authenticated responses are `private, no-store`.
- Added optional-session restricted detail/version routes. Anonymous, unauthorized, disabled, revoked, delisted, and nonexistent reads collapse to private 404 responses.
- Added a strict `private_install_grants` table. Only SHA-256 token hashes are stored, and the schema enforces an exact 600,000 ms lifetime.
- Added protected grant issuance and opaque private download delivery. HEAD and GET validate the token, expiry, publication status, current employee authorization, stored size, and SHA-256 before returning private content.
- Preserved the existing public catalog/package behavior and immutable public package cache policy.
- Regenerated the Promise and Effect Skill Market clients from the public Protocol change.

## Access and revocation coverage

- Public company skills remain available anonymously; group and department publications do not leak.
- Owners and current admins can read published restricted publications.
- Current department peers and current members of active groups can list/read/issue grants.
- Outsiders, disabled-group members, disabled users, invalid sessions, delisted publications, and missing publications are denied.
- Department transfer, group membership removal, grant expiry, and publication delisting revoke an already-issued download grant on its next HEAD/GET.
- Tests verify raw tokens and private object keys are absent from metrics, audit rows, catalog DTOs, and persisted grant rows.

## Files

- Added `packages/skill-market-server/src/restricted-catalog.ts`, `src/install-grants.ts`, and `test/restricted-catalog.test.ts`.
- Updated the shared audience policy, catalog reader/HTTP composition, private delivery route, server wiring, migration, and focused tests.
- Added the restricted detail/version operations to Protocol and regenerated Client output.

## Concerns

- Local delivery remains process-local and reads the private object to verify integrity for both HEAD and GET, matching the existing verified-delivery security posture but potentially increasing object-store bandwidth for installer HEAD requests.
