# Wave 12 OEM Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind every resource temp to a durable WAL identity, keep live invalid owners fenced, use an environment-independent OS-user lock root, and correct Windows ordinary-drive handling.

**Architecture:** A stable OS-account root protects the existing global coordinator/main protocol. Owner identity parsing precedes semantic target validation; exact generation/token resource-temp cleanup occurs only during coordinated dead recovery. Windows classification separates ordinary drive roots from unsafe namespaces.

**Tech Stack:** TypeScript, Node 18 filesystem/OS APIs, Vitest real child processes, Bun tests/typechecks/builds.

## Global Constraints

- Production lock-root resolution must not read HOME, USERPROFILE, XDG, or resource paths.
- Reject symlink, non-directory, foreign-UID roots and OS-user lookup failure.
- Never delete a resource temp without an exact dead generation/token prefix and regular-file no-follow validation.
- Preserve positional callback compatibility while naming it as a scheduling/failure hook.
- No network, dependency installation, publish, push, or PR.
- External credential rotation remains mandatory and separate.

---

### Task 1: Conflict-root and live-owner RED

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

- [x] Add two real children using the same auth/config/test lock root but divergent HOME/USERPROFILE/XDG; pause A and require B to remain before its hook.
- [x] Add production resolver tests proving mutable environment values do not affect the root and lookup/root identity failures reject.
- [x] Add a real acquired owner whose approved parent is swapped; require a contender to remain blocked while the owner PID lives.
- [x] Run focused Vitest and record Wave 11 failures.

### Task 2: Stable root and split owner validation GREEN

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

- [x] Resolve the production root from `userInfo().homedir`, validate directory type/mode/UID, and add an internal test root hook.
- [x] Decode immutable owner identity and target string shape separately from fixed-canonical target validation.
- [x] Inspect live identity before target semantics; dead invalid targets remain canonical and fail closed.
- [x] Bound legacy owner reads/hashing to 64 KiB and run focused GREEN.

### Task 3: WAL-generation resource temp RED to GREEN

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

- [x] Add a real child stopped after auth/config resource-temp fsync and kill it before rename; assert a secret temp exists before recovery.
- [x] Add wrong-generation, wrong-token, partial-prefix, symlink, and directory neighbors; require exact survivors and zero secret matches after recovery.
- [x] Thread the durable journal token/generation through active and recovery atomic writes and temp names.
- [x] Clean exact regular-file temps in approved parents before and after recovery restore; fail closed on exact-prefix non-regular entries.
- [x] Run focused crash/recovery GREEN.

### Task 4: Callback lifetime and Windows roots

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/opencode/src/cli/cmd/import.ts`
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/opencode/test/cli/import.test.ts`

- [x] Rename the positional seam/type to `beforeConfigPublication`/`ConfigPublicationHook` without changing call compatibility.
- [x] Nest release and both anchor closes so cleanup is unconditional; add source/lifecycle coverage.
- [x] Add Windows RED for `C:\\dir/file` and `C://dir`, then accept ordinary drive roots while preserving unsafe namespace rejection.
- [x] Run focused import tests and Opencode typecheck.

### Task 5: Verification, report, and commits

**Files:**
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/.superpowers/sdd/final-fix-report.md`
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/docs/superpowers/plans/2026-07-12-wave12-oem-fixes.md`

- [x] Run fresh Chelper full suite, build, typecheck, diff-check, fresh pack, and silent exact scans.
- [x] Run import tests/typecheck, then Opencode and Desktop builds sequentially.
- [x] Correct Wave 11 claims and append Wave 12 RED/GREEN, cleanup proof, snapshot cap, separator policy, platform limits, and external rotation caveat.
- [x] Commit Chelper code/tests, Primary import code/tests, and docs/report; run post-commit status/scans.
