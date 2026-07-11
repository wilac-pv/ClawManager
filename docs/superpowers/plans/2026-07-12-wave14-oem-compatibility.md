# Wave 14 OEM Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject raw prompt-breaking URL characters and introduce an explicit v2 durable transaction schema without unsafe v1 recovery.

**Architecture:** Brand validates raw code units before WHATWG parsing. Chelper parses owner records as an exact v1/v2 discriminated union, fences live legacy transactions by immutable PID identity, and reserves automatic recovery for v2 records with durable parent identity.

**Tech Stack:** TypeScript, Bun test, Vitest, Node filesystem APIs, tsup.

## Global Constraints

- Reject raw `U+0000..U+0020`, `U+007F`, `U+2028`, and `U+2029`; allow percent-encoded representations.
- Current owner and WAL schemas are version 2.
- Never auto-retire a v1 transaction; live v1 fences and dead v1 requires manual recovery with resources untouched.
- Dead v1 coordinator may retire because it owns no recoverable resource transaction.
- No network, publish, generated-source edits, or external credential rotation claims.

---

### Task 1: Reject raw prompt-breaking URL input

**Files:**
- Modify: `packages/core/src/brand/brand.ts`
- Test: `packages/core/test/brand.test.ts`
- Test: `packages/opencode/test/session/system.test.ts`

**Interfaces:**
- Produces unchanged `docsURL()` and `supportURL()` signatures with a pre-parse raw-character gate.

- [ ] Add table-driven failing tests for LF, CR, tab, `U+2028`, and `U+2029`, plus an accepted `%0A` HTTPS case.
- [ ] Add a failing prompt test that places a unique injection marker after each raw separator and proves marker omission plus bounded output.
- [ ] Run focused tests and record the expected raw values entering Brand/prompt.
- [ ] Add a pre-parse regular-expression guard for `U+0000..U+0020`, `U+007F`, `U+2028`, and `U+2029` before `new URL(value)`.
- [ ] Run both focused suites and package-local typechecks.
- [ ] Commit as `fix(core): reject raw branded URL controls`.

### Task 2: Version durable transactions and fence v1 records

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Test: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/docs/config-publication.md`

**Interfaces:**
- Produces exact parsed owner union for v1/v2 coordinator and transaction shapes.
- Produces v2 owner/WAL writes.
- Produces a clear dead-v1 transaction manual-recovery error before any recovery mutation.

- [ ] Add a real live-v1 owner test with targets that cannot pass current semantic validation; assert contender remains running, no tombstone, canonical main retained.
- [ ] Add a dead-v1 owner/WAL test with historical snapshots; assert manual-recovery error, byte-identical resources, and retained owner/WAL/main.
- [ ] Run both tests and record RED: live v1 is classified legacy/retired and dead v1 may recover through untrusted paths.
- [ ] Replace the owner parser with exact discriminated v1/v2 shapes while preserving immutable PID/token/generation before target semantics.
- [ ] Write new owner and WAL records as version 2; accept only v2 in automatic `readJournal` recovery.
- [ ] In transaction acquisition, after dead-PID detection and before `recoverJournal`, throw the manual-recovery error for v1 transaction owners. Do not retire afterward.
- [ ] Update all current crafted fixtures to explicit v2 and retain dedicated v1 fixtures. Add dead-v1 coordinator coverage if existing behavior is not already explicit.
- [ ] Document v2 and v1 manual recovery in `docs/config-publication.md`.
- [ ] Run focused tests, full `npm test`, and `npm run build`.
- [ ] Commit as `fix(config): version durable transactions`.

### Task 3: Correct report and complete verification

**Files:**
- Modify: `.superpowers/sdd/final-fix-report.md`

**Interfaces:**
- Consumes final commit IDs and verification output.
- Produces preserved Wave 13 correction plus Wave 14 audit evidence.

- [ ] Add an explicit Wave 14 correction beside Wave 13 schema wording without deleting prior evidence.
- [ ] Append Wave 14 RED, implementation-attempt, GREEN, resolver-scope, platform, no-network, and external-rotation evidence.
- [ ] Fresh-run Core Brand tests/typecheck, Opencode system tests/typecheck/build, Chelper full tests/build, diff checks, and changed-file secret scans.
- [ ] Commit as `docs: record Wave 14 verification`.
