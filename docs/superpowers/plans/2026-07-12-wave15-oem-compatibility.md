# Wave 15 OEM Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover all raw Unicode control/format/separator URL input and safely recognize both shipped v1 transaction shapes during a no-overlap upgrade.

**Architecture:** Brand applies a Unicode-category gate before parsing. Chelper expands its exact owner union, refuses live cross-version overlap immediately, and preserves every dead-v1 byte for manual recovery. Documentation defines the operator-enforced reverse compatibility boundary.

**Tech Stack:** TypeScript, Bun test, Vitest, Node filesystem APIs, tsup.

## Global Constraints

- Raw Unicode categories Cc, Cf, and Z are forbidden; percent-encoded equivalents remain allowed.
- Both exact v1 transaction shapes fence before semantics and never retire automatically.
- Dead v1 preserves owner, WAL, auth, and config bytes exactly.
- Different Chelper versions must not overlap; no unsafe dual writes or downgrade.
- No network, publish, generated edits, or external rotation claim.

---

### Task 1: Generalize Brand raw admission

**Files:** `packages/core/src/brand/brand.ts`, `packages/core/test/brand.test.ts`, `packages/opencode/test/session/system.test.ts`

- [ ] Add RED Brand and prompt cases for U+0085, U+00A0, U+2000, U+200B, U+2066, and U+FEFF; add exact accepted percent-encoded equivalents.
- [ ] Run both suites and record raw markers entering Brand/prompt.
- [ ] Replace the finite raw gate with a Unicode property-escape guard for categories Cc, Cf, and Z.
- [ ] Run focused suites and package-local typechecks.
- [ ] Commit `fix(core): reject Unicode branded URL separators`.

### Task 2: Support both v1 shapes and enforce upgrade refusal

**Files:** `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`, `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`, `/Users/gwm/data/github/aicoding-helper/docs/config-publication.md`

- [ ] Add RED live-PID cases for targets-only and Wave13 targets+parents owners; assert immediate clear rejection, exact owner bytes, main retained, and no tombstone.
- [ ] Add RED dead-PID cases for both owner/WAL shapes; compare owner/WAL/auth/config buffers exactly before/after and retain main.
- [ ] Extend the exact v1 union with targets+parents while keeping values unknown before disposition.
- [ ] Reject live v1 immediately with “wait for the older process to exit and retry” guidance; do not wait, validate, retire, or mutate.
- [ ] Keep both dead-v1 shapes on the manual-recovery path before WAL read.
- [ ] Document the stop-upgrade-retry rule and reverse old-reader/v2 limitation.
- [ ] Audit `package.json.files`, fresh `dist/index.js`, and absence of side-by-side legacy readers.
- [ ] Run focused/full tests and build; commit `fix(config): enforce version-isolated upgrades`.

### Task 3: Report and final verification

**Files:** `.superpowers/sdd/final-fix-report.md`

- [ ] Correct Wave14’s single-v1-shape wording and append Wave15 RED/GREEN, package audit, platform/no-network limitations, and external rotation.
- [ ] Fresh-run Brand/system tests, typechecks, Opencode build, Chelper full tests/build, diff checks, package audit, and changed-file credential scans.
- [ ] Commit `docs: record Wave 15 verification`.
