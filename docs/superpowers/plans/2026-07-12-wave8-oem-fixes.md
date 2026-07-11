# Wave 8 OEM Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Wave 8 lock-generation, path-classification, dormant Desktop locale, fixture-placement, and evidence gaps without network access or publication.

**Architecture:** Chelper uses one canonical lock directory generation per canonical auth target. A heartbeat identifies a live generation; release and stale takeover compete for one atomic transition directory, and only its winner renames that generation to a unique quarantine before deletion, so a successor cannot be removed by an observer of its predecessor. Missing targets canonicalize through their deepest existing ancestor. Import validation classifies only true Windows UNC/network names as network shares.

**Tech Stack:** TypeScript, Node filesystem/child-process APIs, Vitest, Bun tests/typechecks/builds.

## Global Constraints

- Use strict RED→GREEN for every behavior change.
- Do not add a network-dependent lock package.
- Do not perform a real network request or publish.
- Preserve `.serena/` and unrelated ignored artifacts.
- Record Linux/Windows-only evidence honestly.
- External credential revocation/rotation remains separate and mandatory.

---

### Task 1: Ownership-safe Chelper lock generations

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Move: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer-process-worker.ts` to `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

**Interfaces:**
- Consumes: `publishRuyingConfig(authPath, apiKey, outputPath, output, publishConfig)`.
- Produces: the same public signature with cross-process serialization keyed by the canonical target.

- [ ] **Step 1: Write failing process tests**

Add real child-process tests for two simultaneous stale breakers, a missing auth file reached through real and symlinked parent aliases, a partial owner record, and cleanup with no canonical lock or quarantine left behind. Point the spawn helper at `test/fixtures/configurer-process-worker.ts`.

- [ ] **Step 2: Verify RED**

Run `npx vitest run src/tools/configurer.test.ts` from `/Users/gwm/data/github/aicoding-helper`. Expect the breaker/alias tests to fail against the single-file compare/unlink protocol and the moved fixture path to be absent.

- [ ] **Step 3: Implement the minimal generation protocol**

Canonicalize by walking upward to the deepest existing ancestor, applying `realpathSync`, and appending missing path segments. Acquire with `mkdirSync(lockPath)`, atomically publish the owner record, maintain an owner heartbeat, and make release/takeover acquire `join(lockPath, "transition")` with `mkdirSync`. After the winner revalidates ownership or staleness, rename the entire lock directory to a token-specific quarantine, then delete only that quarantine. Treat a fresh absent/partial owner as active and an expired one as stale within the acquisition timeout. Do not use PID liveness.

- [ ] **Step 4: Verify GREEN and regression coverage**

Run `npx vitest run src/tools/configurer.test.ts`; expect all configurer tests to pass, with POSIX symlink cases gated off on Windows while protocol tests use Windows-supported filesystem operations.

- [ ] **Step 5: Run Chelper verification**

Run `npm test`, `npm run build`, and `npx tsc --noEmit`; expect exit 0. Pack with `npm pack --ignore-scripts`, scan source, `dist`, tracked files, and the fresh tar for the exact former credential without printing it, then delete the tar.

- [ ] **Step 6: Commit Chelper**

Commit only the Chelper implementation, tests, and fixture move as `fix(config): make lock takeover ownership-safe`.

### Task 2: Exact local-import path classification

**Files:**
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/opencode/src/cli/cmd/import.ts`
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/opencode/test/cli/import.test.ts`

**Interfaces:**
- Consumes/produces: `requireLocalImportPath(file: string): string`.

- [ ] **Step 1: Write failing boundary tests**

Assert rejection of `\\\\server\\share`, `\\\\?\\UNC\\server\\share`, and equivalent extended network forms. Assert acceptance of `\\\\?\\C:\\path`, `//tmp/session.json`, `C://sessions/session.json`, `C:\\sessions\\session.json`, and relative paths. Keep the source-order assertion proving validation precedes `FSUtil.Service`.

- [ ] **Step 2: Verify RED**

Run `bun test test/cli/import.test.ts` from `packages/opencode`; expect valid local double-slash and extended-drive cases to fail under the broad prefix rule.

- [ ] **Step 3: Implement exact classification**

Retain URI-scheme rejection, but reject only backslash UNC names beginning with two backslashes except an extended local drive prefix; explicitly reject case-insensitive extended UNC. Return all accepted local spellings unchanged.

- [ ] **Step 4: Verify GREEN**

Run `bun test test/cli/import.test.ts` and `bun typecheck` from `packages/opencode`; expect exit 0.

### Task 3: Dormant Desktop renderer dictionaries

**Files:**
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/desktop/src/renderer/i18n/*.ts`
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/packages/desktop/src/main/wsl/runtime-contract.test.ts`

**Interfaces:**
- Produces: no visible renderer locale value containing `OpenCode` or the public `opencode` CLI command.

- [ ] **Step 1: Add a failing whole-dictionary audit**

Add an executable audit over every renderer dictionary file that rejects visible `OpenCode` and quoted `opencode` command copy while ignoring internal compatibility identifiers outside dictionaries.

- [ ] **Step 2: Verify RED**

Run the focused Desktop contract test; expect failures listing the dormant dictionaries.

- [ ] **Step 3: Brand dictionary values**

Replace visible product copy with `Ruying Code` and visible CLI command copy with `ruying-code` in all renderer locale dictionaries; do not rename internal protocol/storage identifiers.

- [ ] **Step 4: Verify GREEN**

Run the focused Desktop test and `bun typecheck` from `packages/desktop`; expect exit 0.

### Task 4: Fresh primary verification and Wave 8 report

**Files:**
- Modify: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/.superpowers/sdd/final-fix-report.md`
- Add: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem/docs/superpowers/plans/2026-07-12-wave8-oem-fixes.md`

**Interfaces:**
- Produces: corrected Wave 7 locale scope and honest Wave 8 RED/GREEN, platform, scan, build, commit, and rotation evidence.

- [ ] **Step 1: Correct the report and append evidence**

State that Wave 7 covered App locales but missed dormant Desktop renderer dictionaries. Record exact RED causes, transition-generation invariants, fixture relocation, focused/full results, skipped platform-only tests, and no-network/no-publish scope.

- [ ] **Step 2: Run fresh primary verification**

Run focused Opencode/Desktop tests, typechecks in affected packages, Opencode and Desktop builds sequentially, exact credential scans, `git diff --check`, and `git status --short`. Expect exit 0 except explicitly gated platform tests.

- [ ] **Step 3: Commit primary implementation and report**

Commit code/tests as `fix: close Wave 8 OEM boundaries`, then commit report and plan as `docs: record Wave 8 verification`.
