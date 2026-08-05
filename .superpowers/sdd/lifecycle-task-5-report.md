# Lifecycle task 5 report

## RED

- The focused systemd/backup test started RED: cleanup lacked the explicit
  non-overlap exit behavior, bounded memory/timeouts/retry settings, and a
  partial v12 backup was accepted.
- The focused Chromium E2E started RED because the controlled lifecycle fixture
  had no personal-delete endpoint.

## E2E journeys

- Personal delete becomes hidden, restores before its deadline, and becomes
  irreversible when fixture time reaches exactly seven days and purge runs.
- Withdrawal while a scanner lease is held leaves the submission withdrawn with
  no artifact writes or later scanner status event.
- Delist approval returns a catalog 404 before cleanup; cleanup keeps a shared
  artifact and completes only after its shared-reference count reaches zero.

## Unit, backup, and runbook changes

- The cleanup systemd unit retains the `ruying-market` identity and private
  storage paths, adds bounded memory/timeouts, restart backoff, and a
  non-overlapping flock exit code.
- The backup verifier accepts pre-v12 backups, and at v12 rejects missing
  lifecycle tables, columns, indexes, or lifecycle constraints with a generic
  error that contains no private artifact identity.
- Runbooks state the seven-day restore deadline, irreversible purge, withdraw
  race outcome, visibility-first delist cleanup, and v11/v12 backup/rollback
  commands.

## Gates

- `packages/skill-market-server`: `bun test` — 390 pass; `bun typecheck` — pass.
- `packages/skill-market-web`: `bun run test` — 104 pass; `bun typecheck` —
  pass; `bun run build` — pass; `bun run test:e2e` — 25 pass, 14 skipped.

## Commit and concerns

- Commit: `test(skill-market): verify lifecycle cleanup`.
- The local shell did not expose Bun by default. Gates used
  `/Users/gwm/.bun/bin/bun` or prepended that directory to `PATH`; no repository
  configuration was changed.
