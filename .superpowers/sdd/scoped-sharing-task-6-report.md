# Scoped Sharing Task 6 report

## RED evidence

- `packages/skill-market-server`: `bun test script/backup.test.ts script/deploy-check.test.ts` initially failed because backups accepted a snapshot without migration-011 scoped tables and `runSmoke` had no `restricted-cache` check.
- `packages/skill-market-web`: browser-preloaded moderation tests initially failed because queue/review did not render a resolved scoped audience.

## Fixture matrix

The E2E fixture now has anonymous, group owner, ordinary group member, outsider, same-department user, other-department user, reviewer, and admin personas. The scoped journey verifies group-owner/member detail and grant access, member removal revocation, department versions and department-move revocation, anonymous/outsider/other-department `404`, admin access, and generic public restricted-source `404`.

## Moderation, backup, preflight, and docs

- Queue and review render scope badges with resolved group IDs or department name/ID; private package keys are not rendered.
- Backup verification accepts coherent pre-migration v10 rollback backups and requires every migration-011 scoped table, review artifact snapshot column, critical index, and audience trigger from v11 onward; output remains limited to backup key/digest/version.
- Smoke preflight rejects cacheable restricted list/detail/version/grant/download/404 routes and requires the private missing route to return `404` with `no-store`.
- Server and deploy documentation record the access matrix, ten-minute hashed grants, immediate revocation, enumeration-safe `404`, coordinated audit enum, migration/backup/rollback flags, secret-log exclusions, prefix separation, and two-department controlled validation.

## Gate results

| Command | Result |
| --- | --- |
| `cd packages/schema && PATH=/Users/gwm/.bun/bin:$PATH bun test && bun typecheck` | PASS (37 tests) |
| `cd packages/protocol && PATH=/Users/gwm/.bun/bin:$PATH bun test && bun typecheck` | PASS (21 tests) |
| `cd packages/client && PATH=/Users/gwm/.bun/bin:$PATH bun run check:generated && bun test && bun typecheck` | PASS (19 tests; generated diff clean) |
| `cd packages/skill-market-server && PATH=/Users/gwm/.bun/bin:$PATH bun test && bun typecheck` | PASS (375 tests) |
| `cd packages/skill-market-web && PATH=/Users/gwm/.bun/bin:$PATH bun typecheck` | PASS |
| `cd packages/skill-market-web && PATH=/Users/gwm/.bun/bin:$PATH bun run test` | PASS (98 tests) |
| `cd packages/skill-market-web && PATH=/Users/gwm/.bun/bin:$PATH bun run build` | PASS |
| `cd packages/skill-market-web && PATH=/Users/gwm/.bun/bin:$PATH bun run test:e2e` | PASS (24 passed, 12 project-scoped skips) |
| `cd packages/skill-market-web && PATH=/Users/gwm/.bun/bin:$PATH bun test` | BLOCKED: direct Bun test invocation omits package Happy DOM/browser preloads; 27 unrelated browser-component tests fail with `document is not defined`. Package script is `bun run test`. |

Chromium was installed for this validation using `bunx playwright install chromium`. No deployment was performed.

## Self-review and concerns

`git diff --check` is clean. The only concern is the existing package-command ambiguity above: Task 6’s literal `bun test` bypasses the package’s declared browser test setup. No unrelated test-runner changes were made.

## Follow-up gate fixes

- The outsider fixture now creates an authenticated session, and the scoped journey proves that authenticated outsider still receives `404`.
- The same journey retains the member-removal case and adds disabled-group revocation: an active member receives exactly one Aurora restricted list card, a disabled group removes that card immediately, and the direct detail route returns `404`.
- Backup schema verification now accepts coherent v10 pre-migration rollback backups while requiring the migration-011 schema safeguards for v11 and later.

Focused follow-up results: `bun test script/backup.test.ts script/deploy-check.test.ts` passed 13 tests; `bunx playwright test e2e/market.e2e.ts --grep "enforces scoped sharing"` passed 1 desktop test with 2 project skips.
