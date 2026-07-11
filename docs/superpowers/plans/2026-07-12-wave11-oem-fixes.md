# Wave 11 OEM Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize all per-user Chelper auth/config transactions, harden fixed-canonical WAL recovery and retirement, and reject Windows network/device import namespaces.

**Architecture:** One user-global coordinator protects one durable main transaction generation. Strict owner/WAL validation precedes descriptor-verified fixed-target I/O; fresh metadata-only tombstones fence dead generations without retaining journal bytes. Windows import uses an explicit local namespace allowlist.

**Tech Stack:** TypeScript, Node 18 filesystem/process APIs, Vitest real child processes, Bun tests/typechecks/builds.

## Global Constraints

- Use one per-user global Chelper configuration transaction lock.
- No lease, heartbeat, live-PID time eviction, dependency installation, network, publish, push, or PR.
- Treat owner metadata as the trusted source of exact fixed-canonical targets; validate the complete WAL before either restore.
- Use mode `0700` lock roots/generations and mode `0600` metadata/journal files.
- Node pathname verification is not claimed as portable `renameat`; parent identity changes fail closed.
- External credential rotation remains mandatory and separate.

---

### Task 1: Global conflict domain and strict recovery RED

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

**Interfaces:**
- Consumes: existing `publishRuyingConfig(authPath, apiKey, outputPath, output, publishHook, hooks)` test seam.
- Produces: real-process behavioral contract for one global transaction and crash recovery.

- [x] Add a real same-config/different-auth child interleaving; pause A and assert B cannot reach its hook until A releases.
- [x] Add crafted owner/WAL table cases for extra/missing keys, wrong version/state/token/generation/targets, noncanonical targets/base64, invalid mode, unsupported kind, oversized journal, and oversized snapshot; assert both resources remain byte-identical and the main stays canonical.
- [x] Add a real crash after fsynced journal temp but before rename; assert the successor removes temps, recovers the prior journal state, and leaves fresh metadata-only tombstones.
- [x] Run `npx vitest run src/tools/configurer.test.ts` and record failures caused by the Wave 10 auth-keyed conflict domain, permissive WAL, and temp retention.

### Task 2: Safe global root, owner, WAL, and retirement GREEN

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

**Interfaces:**
- Consumes: Task 1 behavioral tests.
- Produces: global lock root; strict owner/journal codecs; metadata-only retirement; durability hooks.

- [x] Replace auth-derived lock paths and process queue identity with one canonical per-user data-root path; create it mode `0700` and reject symlink/non-directory roots.
- [x] Publish exact-key versioned owner metadata containing PID, token, generation, and trusted canonical target pair; fsync owner, candidate directory, parent, and canonical rename transitions.
- [x] Decode the entire bounded journal into validated snapshots before restore; require canonical base64, integer `0..0777` modes, exact matching owner token/generation/targets, and exact keys.
- [x] Remove journal temps before retirement and publish fresh fsynced metadata-only deterministic tombstones before removing the old generation under the coordinator.
- [x] Keep live-PID timeout conservative and document that no portable process-start identity is used when it cannot be observed reliably.
- [x] Run the focused Chelper test after each minimal implementation slice until GREEN.

### Task 3: Descriptor-verified fixed resource I/O

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

**Interfaces:**
- Consumes: trusted fixed targets and snapshots from Task 2.
- Produces: verified snapshot/read/sync/publish/restore operations and test-only callback scheduling.

- [x] Add POSIX RED tests that replace auth/config with a symlink and device during the callback window; assert explicit failure and unchanged victims.
- [x] Add RED tests for parent identity changes and namespace durability hook ordering across candidate acquire, journal replace, tombstone, release rename, and cleanup.
- [x] Open fixed parents and regular files no-follow where available; compare pre-open `lstat`, descriptor `fstat`, post-open `lstat`, and parent descriptor fingerprints before temp creation and before/after namespace mutation.
- [x] Make the callback a scheduling/failure hook only, then publish config bytes internally with the verified atomic primitive.
- [x] Run the focused suite and preserve the documented Node `renameat` limitation.

### Task 4: Windows local-path allowlist

**Files:**
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/opencode/src/cli/cmd/import.ts`
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/opencode/test/cli/import.test.ts`

**Interfaces:**
- Consumes: `isNetworkImportPath(file, platform)` and validation-before-`FSUtil.Service` contract.
- Produces: allowlisted Windows local path classification.

- [x] Add RED matrix cases for allowed ordinary drives, consistent extended drives, and valid Volume GUID paths; reject UNC, device, named pipe, `GLOBALROOT`, redirector, malformed volume, doubled separators, and mixed-leading separators.
- [x] Implement the minimal explicit Windows namespace parser while retaining non-Windows POSIX `//tmp` behavior and backslash network rejection.
- [x] Run `bun test test/cli/import.test.ts` and `bun typecheck` from `packages/opencode`.

### Task 5: Fresh verification, report, and commits

**Files:**
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/.superpowers/sdd/final-fix-report.md`
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/docs/superpowers/plans/2026-07-12-wave11-oem-fixes.md`

**Interfaces:**
- Consumes: Tasks 1-4 evidence.
- Produces: corrected Wave 10 report and clean committed repositories.

- [x] Run fresh `npm test`, `npm run build`, `npx tsc --noEmit`, `git diff --check`, a fresh npm pack, and silent exact-value scans in Chelper.
- [x] Run focused import tests, `bun typecheck`, `bun run build --single --skip-install`, then Desktop `bun run build` sequentially.
- [x] Correct Wave 10 conflict-domain/anchoring/retirement overclaims; append Wave 11 RED/GREEN, power-loss and Windows limitations, PID availability caveat, no-network statement, and mandatory external rotation.
- [x] Commit Chelper production/tests, Primary import code/tests, and Primary docs/report with conventional commit messages; run post-commit status, diff, and exact scans.
