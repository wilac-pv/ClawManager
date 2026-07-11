# Wave 13 OEM Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound OEM-controlled model-visible URLs and make durable configuration recovery verify parent-directory identity while performing only capped file reads.

**Architecture:** Core admits docs/support URLs through one strict validator before any consumer sees them. Chelper records bigint filesystem identity in owner and WAL, holds verified parent anchors across publication, and uses a single max+1 descriptor-reader for all attacker-influenced durable files. Production root selection is factored into a pure function so real child processes can exercise it without creating user-home artifacts.

**Tech Stack:** TypeScript, Bun test, Node filesystem APIs, Vitest, tsup.

## Global Constraints

- Brand docs/support URLs must be parseable HTTPS URLs without username/password and at most 512 UTF-8 bytes; accepted values retain their original string.
- Parent `dev` and `ino` identities come from bigint filesystem metadata and persist as canonical decimal strings in owner and WAL.
- Owner, WAL, and snapshots read at most their configured maximum plus one byte.
- Recovery compares current and persisted parent identities before any resource write or cleanup.
- Production resolver child evidence covers path selection only and must not create artifacts in the real user directory.
- Preserve review-stage history; no network, publish, generated-source edits, or external credential rotation claims.

---

### Task 1: Bound Brand URLs before prompt use

**Files:**
- Modify: `packages/core/src/brand/brand.ts`
- Test: `packages/core/test/brand.test.ts`
- Test: `packages/opencode/test/session/system.test.ts`

**Interfaces:**
- Consumes: existing `env(suffix: string): string | undefined`.
- Produces: unchanged public `docsURL(): string | undefined` and `supportURL(): string | undefined` with strict admission.

- [ ] **Step 1: Write failing Brand boundary tests**

Add cases that construct exact byte boundaries and reject credentials:

```ts
const docsPrefix = "https://internal.example/"
process.env.RUYING_CODE_DOCS_URL = docsPrefix + "a".repeat(512 - Buffer.byteLength(docsPrefix))
expect(Buffer.byteLength(Brand.docsURL()!)).toBe(512)
process.env.RUYING_CODE_DOCS_URL += "a"
expect(Brand.docsURL()).toBeUndefined()
process.env.RUYING_CODE_DOCS_URL = "https://user:password@internal.example/docs"
expect(Brand.docsURL()).toBeUndefined()
process.env.RUYING_CODE_DOCS_URL = "http://internal.example/docs"
expect(Brand.docsURL()).toBeUndefined()
process.env.RUYING_CODE_DOCS_URL = "not a url"
expect(Brand.docsURL()).toBeUndefined()
```

- [ ] **Step 2: Write the failing model-visible 20k injection test**

Set `RUYING_CODE_DOCS_URL` and `RUYING_CODE_SUPPORT_URL` to HTTPS-prefixed 20,000-character payloads, call `SystemPrompt.provider(...)`, and assert the marker is absent and the output length stays below the baseline plus 1,024 bytes.

- [ ] **Step 3: Run RED tests**

Run from `packages/core`: `bun test test/brand.test.ts`.
Run from `packages/opencode`: `bun test test/session/system.test.ts`.
Expected: boundary/credential tests and the prompt-injection test fail because raw environment values are returned.

- [ ] **Step 4: Implement the minimal shared validator**

In `brand.ts`, add one internal function and route only docs/support through it:

```ts
function url(suffix: string) {
  const value = env(suffix)
  if (!value || Buffer.byteLength(value, "utf8") > 512) return
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return
    return value
  } catch {
    return
  }
}

export function docsURL() {
  return url("DOCS_URL")
}
```

Apply the same call to `supportURL`; leave changelog behavior unchanged.

- [ ] **Step 5: Run GREEN tests and typechecks**

Run from `packages/core`: `bun test test/brand.test.ts && bun typecheck`.
Run from `packages/opencode`: `bun test test/session/system.test.ts && bun typecheck`.
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/brand/brand.ts packages/core/test/brand.test.ts packages/opencode/test/session/system.test.ts
git commit -m "fix(core): bound branded support URLs"
```

### Task 2: Use max+1 reads and expose artifact-free root selection

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Test: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

**Interfaces:**
- Produces: `resolveGlobalLockRootPath(): string`; `resolveGlobalLockRoot()` continues to create/validate that result.
- Produces: internal bounded reader `readRegularFileNoFollow(path, maximum, beforeRead?)` that allocates no more than `maximum + 1`.
- Produces: synchronous test hook `onBoundedRead?: (path: string) => void`, invoked after descriptor identity verification and before reading.

- [ ] **Step 1: Write failing resolver child tests**

Spawn two fixture children without `lockRoot`, give them divergent `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME`, and have resolver mode print `resolveGlobalLockRootPath()`. Assert both absolute paths are equal and that no filesystem entry was created at the result by the selector.

- [ ] **Step 2: Write failing concurrent-growth tests**

Add deterministic owner/WAL/snapshot cases. Each begins at the relevant maximum and uses `onBoundedRead(path)` to append one byte only for the selected file after verified open. Assert publication/recovery rejects with the size error, neither auth nor config changes, and no callback allocation/read exceeds maximum plus one.

- [ ] **Step 3: Run RED tests**

Run: `npm test -- --run src/tools/configurer.test.ts` from `/Users/gwm/data/github/aicoding-helper`.
Expected: resolver export/hook is absent and concurrent growth can escape the pre-size check.

- [ ] **Step 4: Implement production path selection**

```ts
export function resolveGlobalLockRootPath() {
  return join(userInfo().homedir, ".ruying-code-configuration")
}

export function resolveGlobalLockRoot(expectedUid = process.getuid?.()) {
  return ensureGlobalLockRoot(resolveGlobalLockRootPath(), expectedUid)
}
```

Add fixture mode that reports only the pure selector; do not call `resolveGlobalLockRoot()` in that mode.

- [ ] **Step 5: Implement the bounded descriptor loop**

Import `readSync`, allocate `Buffer.allocUnsafe(maximum + 1)`, and loop until EOF or the buffer is full. Run the synchronous hook after lstat/fstat/lstat identity checks. Reject when bytes read exceed `maximum`, and return `buffer.subarray(0, length)`. Use this reader for owner and journal. For snapshots, run the same bounded loop against the already verified descriptor instead of `readFileSync`.

- [ ] **Step 6: Run GREEN tests and build**

Run: `npm test -- --run src/tools/configurer.test.ts && npm run build`.
Expected: all pass and tsup exits 0.

- [ ] **Step 7: Commit in Chelper**

```bash
git add src/tools/configurer.ts src/tools/configurer.test.ts test/fixtures/configurer-process-worker.ts
git commit -m "fix(config): bound recovery file reads"
```

### Task 3: Persist and enforce parent-directory identity

**Files:**
- Modify: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.ts`
- Test: `/Users/gwm/data/github/aicoding-helper/src/tools/configurer.test.ts`
- Modify: `/Users/gwm/data/github/aicoding-helper/test/fixtures/configurer-process-worker.ts`

**Interfaces:**
- Produces: `ParentIdentity = { dev: string; ino: string }` and transaction `parents: { auth: ParentIdentity; config: ParentIdentity }` in owner and Journal.
- Consumes: held `FileAnchor` descriptors created before `claimLock`.

- [ ] **Step 1: Write failing codec tests**

Assert owner and WAL contain exact `parents.auth/config.dev/ino` decimal strings. Table-test missing, extra, signed, leading-zero, nonnumeric, and owner/WAL-mismatched values; every case must fail before auth/config mutation.

- [ ] **Step 2: Write the failing real replacement-directory crash test**

Start a child that reaches a durable non-committed journal state, kill it, rename the original resource parent, create a real replacement directory at the same pathname, and write victim auth/config bytes. Snapshot the replacement tree byte-for-byte, attempt recovery, assert rejection, then compare the tree and bytes exactly and assert the canonical transaction generation remains for inspection.

- [ ] **Step 3: Run RED tests**

Run: `npm test -- --run src/tools/configurer.test.ts`.
Expected: owner/WAL lack parents and recovery mutates or cleans through the replacement pathname.

- [ ] **Step 4: Implement bigint identity encoding and strict validation**

Call `lstatSync(parent, { bigint: true })` when capturing pathname identity and `fstatSync(descriptor, { bigint: true })` for the held descriptor. Persist `dev.toString()` and `ino.toString()`. Accept only canonical nonnegative decimal strings:

```ts
function isDeviceIdentity(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
}
```

Require exact nested keys and exact owner/WAL identity equality.

- [ ] **Step 5: Anchor before owner publication and verify before recovery mutation**

In acquisition, create both anchors while the coordinator is held, derive `parents`, then call `claimLock(lock, hooks, { targets, parents })`; close both anchors on a failed claim or exception. In recovery, validate the complete owner/WAL, create current anchors, compare their identities to persisted identities, and only then call temp cleanup or restore. Any mismatch throws before `cleanupResourceTemps`, `restoreFixed`, journal removal, or retirement.

- [ ] **Step 6: Run GREEN and regression tests**

Run: `npm test -- --run src/tools/configurer.test.ts && npm test && npm run build`.
Expected: all pass; `.serena/` remains untouched.

- [ ] **Step 7: Commit in Chelper**

```bash
git add src/tools/configurer.ts src/tools/configurer.test.ts test/fixtures/configurer-process-worker.ts
git commit -m "fix(config): bind recovery to parent identity"
```

### Task 4: Document limits, verify both repositories, and record Wave 13

**Files:**
- Modify: `.superpowers/sdd/final-fix-report.md`
- Create: `/Users/gwm/data/github/aicoding-helper/docs/config-publication.md`

**Interfaces:**
- Consumes: final test/build results and commit IDs from Tasks 1-3.
- Produces: precise Wave 13 report without broadening resolver or external-action claims.

- [ ] **Step 1: Create operator-facing behavior documentation**

Create `docs/config-publication.md`. Document that the publication callback is a scheduling/failure hook and does not own resource bytes; the bounded-read hook is synchronous test support after verified open and before read, with propagated exceptions. State 64 KiB owner, 48 MiB WAL, and 16 MiB per decoded snapshot limits. Keep the separate 512-byte HTTPS Brand rule in the primary review report because Brand is not a Chelper interface.

- [ ] **Step 2: Correct recovery wording**

State that accepted target paths are exact absolute fixed-canonical strings and that durable parent `dev`/`ino` decimal identities must match current verified anchors before resource writes. Describe child evidence only as environment-independent production path selection; do not claim acquisition in the real user directory.

- [ ] **Step 3: Run fresh verification**

Primary, from package directories:

```bash
(cd packages/core && bun test test/brand.test.ts && bun typecheck)
(cd packages/opencode && bun test test/session/system.test.ts && bun typecheck && bun run build)
```

Chelper:

```bash
npm test
npm run build
```

Expected: all exit 0.

- [ ] **Step 4: Run bounded scans and inspect diffs**

Use repository secret-pattern scans, `git diff --check`, `git status --short`, and review diffs against primary `dev`/`origin/dev` plus the Chelper base. Confirm no generated files, `.serena/`, dependencies, or artifacts are included.

- [ ] **Step 5: Append Wave 13 evidence and caveats**

Record RED failures honestly, GREEN command outputs, build/scans, commit IDs, no-network/no-publish status, the resolver-selection-only limitation, Windows UID limitation, bounded-memory availability tradeoff, and mandatory external credential revocation/rotation as not completed.

- [ ] **Step 6: Commit report changes**

```bash
git add .superpowers/sdd/final-fix-report.md docs/superpowers/plans/2026-07-12-wave13-oem-hardening.md
git commit -m "docs: record Wave 13 verification"
```

Commit the Chelper operator document with the Chelper implementation commit that introduces the documented behavior.
