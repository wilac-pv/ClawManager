# Typography Task 2 report

## RED

Added focused browser assertions for page-heading classes, machine IDs, shared badge typography, and removal of incidental English eyebrows. The first failure was `src/shell.test.tsx`: `E000001` did not have the `machine-id` class.

## Classes

Defined and applied `.type-page-title`, `.type-section-title`, `.type-card-title`, `.type-body`, `.type-secondary`, `.type-label`, and `.type-badge` using the Task 1 typography variables. Controls retain `font: inherit`; `.machine-id` remains in the monospace-only selector.

## Components

Updated the market shell, favorites (and its shared personal page header), submission detail, moderation queue and review, roles, audit, announcement administration, SkillHub synchronization, and announcement carousel/history/detail components.

## Copy

Replaced incidental English eyebrows: `Saved skills` with `收藏内容`; removed `Reviewer workspace`, `Admin workspace`, `Announcement`, and `Ruying SkillHub updates`.

## Commands and results

1. `PATH=/Users/gwm/.bun/bin:$PATH bun run test:browser` — RED: missing `machine-id` on `E000001`.
2. `PATH=/Users/gwm/.bun/bin:$PATH bun run test:browser` — GREEN: 74 pass, 0 fail.
3. `PATH=/Users/gwm/.bun/bin:$PATH bun typecheck` — pass.
4. `PATH=/Users/gwm/.bun/bin:$PATH bun run build` — pass.

## Commit

`fix(skill-market): apply Chinese type hierarchy`

## Follow-up fixes

Removed the eyebrow typography override; applied label/body classes to every submission and review overview fact; marked review machine identifiers; and applied card-title/secondary classes to all moderation queue row titles and owner metadata. Focused browser tests passed 20/20 and `bun typecheck` passed.
