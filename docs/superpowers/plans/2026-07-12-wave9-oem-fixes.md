# Wave 9 OEM Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unfenced Chelper lease with a crash-recoverable short commit mutex plus token/fingerprint rollback fencing, and classify forward-slash UNC paths by platform.

**Architecture:** A complete owner record is written in a unique candidate directory before an atomic rename claims the canonical commit mutex. Live PIDs are never evicted; clearly dead canonical generations are renamed to a deterministic, permanent, non-empty token tombstone so every delayed observer of that generation collides with the same tombstone and cannot rename a successor. The mutex covers only canonical auth snapshot/publication/marker and rollback CAS; config publication remains outside it. A persistent publication marker and auth fingerprint distinguish identical-byte successors.

**Tech Stack:** TypeScript, Node 18 filesystem/process APIs, Vitest child processes, Bun tests/typechecks/builds.

## Global Constraints

- Strict RED→GREEN for every behavior change.
- No heartbeat, elapsed-time lease, transition directory, or unfenced stale deletion.
- A PID that currently exists is conservatively treated as live, including possible PID reuse.
- One permanent non-empty tombstone per real dead canonical generation is an accepted safety/storage tradeoff.
- No external network request, package installation, publish, push, or PR.
- External credential rotation remains mandatory and separate.

---

### Task 1: Candidate-based short commit mutex

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

**Interfaces:**
- Preserve `publishRuyingConfig(authPath, apiKey, outputPath, output, publishConfig)` for production callers.
- Add only the bounded test hook needed to pause after a complete candidate owner is published and before canonical claim.

- [ ] **Step 1: Write failing real-process mutex tests**

Add tests for a killed candidate creator followed by successful acquisition, a live paused owner that is never time-evicted, two delayed breakers of one dead token racing with a successor, normal release leaving no mutex artifacts, and at most one non-empty deterministic tombstone for one real dead generation.

- [ ] **Step 2: Verify mutex RED**

Run `npx vitest run src/tools/configurer.test.ts` from Chelper. Expect failures because Wave 8 still uses lease/heartbeat/transition/quarantine deletion.

- [ ] **Step 3: Implement candidate claim and dead-generation tombstones**

Write `{pid, token}` completely inside `<lock>.<pid>.<token>.candidate`, fsync it, then atomically rename the candidate to canonical. On collision, read the canonical complete owner. Wait for live PID. For a clearly dead PID, rename canonical to deterministic `<lock>.<observed-token>.dead` and never delete that non-empty tombstone. Delayed observers must use the same destination. Clean only unique dead candidate directories; never break a current PID by age.

- [ ] **Step 4: Verify mutex GREEN**

Run the focused real-process tests. Expect all to pass without heartbeat/lease/transition source terms.

### Task 2: Token/fingerprint rollback fencing and canonical targets

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

**Interfaces:**
- The persistent adjacent publication marker records transaction token, canonical target, and published auth fingerprint.
- All auth snapshot, write, comparison, and restore operations consume the fixed canonical target rather than the mutable alias.

- [ ] **Step 1: Write failing successor and symlink tests**

Use real processes to prove B with identical auth bytes gets a distinct marker while A is paused, A's later failure cannot restore over B, and retargeting an auth or parent symlink sends B to the new canonical target while A can only restore its owned old target.

- [ ] **Step 2: Verify fencing RED**

Run the focused tests. Expect Wave 8's long lock/byte-only rollback behavior to fail successor progress, identical-byte ownership, or retarget safety.

- [ ] **Step 3: Implement short fenced boundaries**

Under the commit mutex, canonicalize and revalidate the target, snapshot auth and marker, publish auth plus a unique marker, then release. Run config publication outside the mutex. On failure, reacquire the original canonical target mutex and restore only when marker token, marker target, and current auth fingerprint all match A's publication; restore the previous marker state with the auth snapshot. Never write through the mutable alias during rollback.

- [ ] **Step 4: Verify fencing GREEN**

Run all Chelper configurer tests, then `npm test`, `npm run build`, `npx tsc --noEmit`, and `git diff --check`.

### Task 3: Platform-aware forward-slash UNC

**Files:**
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/opencode/src/cli/cmd/import.ts`
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/opencode/test/cli/import.test.ts`

**Interfaces:**
- Produce a pure platform-aware network-path classifier used by `requireLocalImportPath`.

- [ ] **Step 1: Write failing platform matrix**

Assert Windows rejects `//server/share` and `//?/UNC/server/share`, non-Windows accepts POSIX `//tmp/session.json`, all platforms reject backslash UNC, and extended local drives remain accepted. Preserve validation-before-`FSUtil.Service` evidence.

- [ ] **Step 2: Verify import RED**

Run `bun test test/cli/import.test.ts`; expect the Windows forward-slash cases to be accepted by the Wave 8 classifier.

- [ ] **Step 3: Implement and verify GREEN**

Implement the platform parameter boundary, rerun the focused test, and run `bun typecheck` from `packages/opencode`.

### Task 4: Report, builds, scans, and commits

**Files:**
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/.superpowers/sdd/final-fix-report.md`
- Add: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/docs/superpowers/plans/2026-07-12-wave9-oem-fixes.md`

- [ ] **Step 1: Correct Wave 8 and append Wave 9**

Retract lease/PID-reuse/transition safety overclaims, record the permanent crash-tombstone tradeoff, exact RED/GREEN evidence, platform execution limits, no-network scope, and external rotation caveat.

- [ ] **Step 2: Run fresh verification**

Run Chelper full tests/build/typecheck/fresh pack scan; Opencode focused test/typecheck/build; Desktop sequential build if required by shared dist; exact credential scans and post-commit diff/status checks.

- [ ] **Step 3: Commit coherently**

Commit Chelper as `fix(config): fence cross-process rollback`, Primary code as `fix(opencode): classify platform UNC paths`, and report/plan as `docs: record Wave 9 verification`.
