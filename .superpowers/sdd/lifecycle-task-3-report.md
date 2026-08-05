# Lifecycle Task 3 Report

## RED

- Submission transition RED: `validating -> withdrawn` raised `submission-conflict` because the transition was absent.
- Withdrawal RED: `Submissions.withdraw` was undefined.
- Worker race RED: a validator resumed after withdrawal and wrote `manifest.json` and `scan.json` despite leaving the database row withdrawn.
- Delist request RED: `Submissions.requestDelist` was undefined.
- Delist decision RED: `Moderation.decideDelist` was undefined.
- HTTP composition RED: the implemented lifecycle handlers resolved an undefined group because the lifecycle groups were not composed into `SkillMarketApi`.

## State matrix

| Current submission status | Owner withdraw |
| --- | --- |
| `validating` | allowed with matching version |
| `validation_failed` | allowed with matching version |
| `pending_review` | allowed with matching version |
| `changes_requested` | allowed with matching version |
| `publish_failed` | allowed with matching version |
| `publishing` | conflict |
| `published` | conflict; owner may request delist |
| `rejected` | conflict |
| `withdrawn` | conflict |

Successful withdrawal changes the status to `withdrawn`, increments the submission version once, clears the user message and validation/publication leases, and records a bounded audit payload without package or reason secrets. Withdrawn submissions remain owner-readable history, are excluded from the moderation queue, and are outside the existing active submission/duplicate indexes.

## Stale-worker fences

- Validation claims carry submission ID, revision, `validating` status, submission version, and lease owner.
- The worker rechecks the durable fence after archive validation and before persisting validation artifacts or completing either a successful or invalid result.
- Withdrawal clears validation and publication leases transactionally. A stale publisher cannot persist its target or move the public catalog pointer after losing the claimed job lease.
- Focused race coverage confirms a resumed validator returns `stale`, leaves validation columns untouched, and writes no derived objects; publisher coverage confirms the withdrawn row remains terminal and the public pointer does not expose the candidate.

## Delist decisions and visibility

- Only the owner of a live `published` submission can create a request, with matching submission version and a schema-bounded reason. The partial unique index and service check permit only one pending request per submission.
- Admin approval first changes the live company or restricted publication to a non-visible state in the transaction, then versions and records the approved request and audit decision. Company approval queues the existing catalog rebuild mechanism.
- Native personal publication delivery rejects an approved delist request while retaining submission history.
- Rejection only versions and records the request; community/restricted/personal publication state remains unchanged.
- Admin middleware and the service-level Admin check both protect decisions. Stale request versions and retries return `submission-conflict`; owner-scoped misses remain `not-found`.
- Approval durably queues artifact cleanup after publication invisibility changes in the same transaction. The existing cleanup run leases queued work, rechecks approval and invisibility, protects artifacts referenced by personal, restricted, or other revisions, and completes idempotently. Rejection queues no cleanup.

## Commands and results

- Baseline: `/Users/gwm/.bun/bin/bun test test/submissions.test.ts test/moderation.test.ts test/publisher.test.ts test/worker.test.ts test/control-http.test.ts` — 99 pass, 0 fail.
- Required generator after lifecycle API composition: `PATH=/Users/gwm/.bun/bin:$PATH /Users/gwm/.bun/bin/bun run generate` from `packages/client` — exit 0; generated client identity produced no tracked diff.
- Client composition check: `PATH=/Users/gwm/.bun/bin:$PATH /Users/gwm/.bun/bin/bun typecheck` from `packages/client` — exit 0.
- Final prescribed verification: `/Users/gwm/.bun/bin/bun test test/submissions.test.ts test/moderation.test.ts test/publisher.test.ts test/worker.test.ts test/control-http.test.ts && PATH=/Users/gwm/.bun/bin:$PATH /Users/gwm/.bun/bin/bun typecheck` from `packages/skill-market-server` — 104 pass, 0 fail; typecheck exit 0.

## Commit and concerns

- Commit: `feat(skill-market): add withdrawal and delisting` (this commit).
- Environment note: Bun is installed at `/Users/gwm/.bun/bin/bun` but was not present on the shell `PATH`; verification used the explicit binary and generator runs prepended its directory.
- Functional concerns: none found in the focused lifecycle scope.

## Review follow-up

- Kept migration 012's partial unique index on pending delist requests and made the insert use that index as the final concurrency authority. SQLite busy and unique races now map to the stable `submission-conflict` domain error.
- Added a two-connection regression test: a competing writer sees `submission-conflict`, a raw concurrent insert is rejected by the durable partial index, and exactly one pending request survives.
- Added a durable, leased cleanup queue in migration 012. Approved decisions enqueue only after publication visibility is removed; rejected decisions do not enqueue.
- Extended the existing cleanup command to claim retryable jobs, recheck approval and publication invisibility, protect shared private artifacts, delete unreferenced private/public objects, and record completion. A second run performs no work.
- Focused verification: `/Users/gwm/.bun/bin/bun test test/submissions.test.ts test/moderation.test.ts test/publisher.test.ts script/cleanup.test.ts` from `packages/skill-market-server` — 70 pass, 0 fail.
- Type verification: `/Users/gwm/.bun/bin/bun typecheck` from `packages/skill-market-server` — exit 0.
- Follow-up commit: `fix(skill-market): harden delist cleanup` (this commit).
