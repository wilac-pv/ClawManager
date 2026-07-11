# Wave 10 OEM Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chelper auth/config publication a no-lease, ordered, crash-recoverable WAL transaction and close legacy-lock, alias, marker, and mixed-UNC gaps.

**Architecture:** A short candidate-published lifecycle coordinator serializes main generation inspection, recovery, installation, and release. The main owner remains held through both durable resource writes. A versioned journal inside the main lock is atomically updated with temp+fsync+rename+parent-fsync; non-committed recovery rolls both fixed canonical targets back, while committed recovery keeps both. Dead generations become deterministic non-empty metadata-only tombstones.

**Tech Stack:** TypeScript, Node 18 filesystem/process APIs, Vitest real child processes, Bun tests/typechecks/builds.

## Global Constraints

- No elapsed-time lease, heartbeat, or live-PID eviction.
- No secret bytes in permanent tombstones.
- All resource inspection and restoration is no-follow and rejects symlink/nonregular canonical targets.
- Invalid journal version/schema/targets fails closed without touching auth or config.
- No external network, dependency installation, publish, push, or PR.
- External credential rotation remains mandatory and separate.

---

### Task 1: Write-ahead transaction RED tests

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

- [x] Add real two-success ordering with A paused in config and final B auth/config.
- [x] Add child-kill boundaries after prepared, auth-published, config-published, and committed.
- [x] Add recovery-holder kill followed by idempotent recovery, two contenders, and secret-free tombstone assertions.
- [x] Add legacy empty/malformed main/coordinator bounded-backoff, candidate/release cleanup, marker-symlink victim, dangling alias, and invalid-journal fail-closed tests.
- [x] Run focused Vitest and record valid Wave 9 failures.

### Task 2: Coordinator, WAL, and fixed-target implementation

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

- [x] Implement complete-candidate ownership locks with conservative PID checks, deterministic dead/legacy tombstones, bounded malformed rereads, and provable candidate/release cleanup.
- [x] Acquire the main generation only while coordinator is held; recover its journal in place before tombstoning and installing a successor.
- [x] Implement versioned journal schema validation, fixed expected targets, base64 absent/file snapshots, mode preservation, no-follow regular-file checks, and atomic durable journal replacement.
- [x] Hold main through WAL prepare, auth write, fixed-target config callback, committed journal state, journal deletion, and coordinator-serialized release.
- [x] Remove the Wave 9 publication marker and safely unlink only the legacy marker entry itself.
- [x] Run focused then full Chelper tests, build, typecheck, and diff-check.

### Task 3: Mixed-separator UNC

**Files:**
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/opencode/src/cli/cmd/import.ts`
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/opencode/test/cli/import.test.ts`

- [x] Add Windows mixed-separator UNC rejection and mixed local-drive acceptance matrix; preserve non-Windows POSIX roots and validation-before-FS evidence.
- [x] Run RED, normalize only for Windows classification, then run GREEN and Opencode typecheck.

### Task 4: Verification, report, and commits

**Files:**
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/.superpowers/sdd/final-fix-report.md`
- Add: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/docs/superpowers/plans/2026-07-12-wave10-oem-fixes.md`

- [x] Correct Wave 9 ordering/crash-recovery overclaims and append Wave 10 design, RED/GREEN, crash semantics, platform limits, and disk/PID tradeoffs.
- [x] Run fresh Chelper suite/build/typecheck/fresh-pack scan and Primary focused/typecheck/sequential builds/exact scans.
- [x] Commit Chelper `fix(config): make publication crash recoverable`, Primary `fix(opencode): reject mixed UNC paths`, and docs `docs: record Wave 10 verification`.
