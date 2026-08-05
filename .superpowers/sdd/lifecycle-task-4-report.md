# Lifecycle task 4 report

## RED

Added focused data-source, personal-delete, trash, withdrawal/delist, navigation, and Admin delist-decision tests before their matching implementation. The test runner could not execute: the required `bun` executable is unavailable in this shell (`zsh: command not found: bun`, exit 127).

## Visibility matrix

| Action | Visible to |
| --- | --- |
| Delete personal Skill | Published personal Skill rows only |
| Restore personal Skill | Recoverable trash rows only |
| Withdraw | validating, validation_failed, pending_review, changes_requested, publish_failed |
| Request delist | Published non-personal submission owner |
| Decide delist | Admin only |

## Dialog accessibility

Destructive dialogs have `role="dialog"`, `aria-modal`, a labelled heading, safe Cancel initial focus, Escape handling, disabled controls while pending, and restore focus to the trigger after close/success. Errors expose `MarketControlError.requestId`.

## Payloads and invalidation

Lifecycle writes send CSRF plus caller-generated idempotency keys. Delete/restore invalidate `submissions` and `personal-trash`; withdrawal updates the detail query and invalidates `submissions`.

## Commands and results

From `packages/skill-market-web`:

`bun run test:unit && bun run test:browser && bun typecheck && bun run build`

Result: not run; shell reports `bun: command not found` before the unit suite starts.

## Commit and concerns

Commit pending.

The existing Protocol exposes delist request/decision mutations but has no query that supplies pending delist requests to an Admin submission detail. The Admin decision component therefore accepts an optional request value, but the normal route cannot surface a pre-existing request without a follow-up read/list contract.
