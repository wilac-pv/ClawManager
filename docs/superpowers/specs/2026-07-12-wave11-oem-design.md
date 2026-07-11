# Wave 11 OEM Transaction and Import Design

Date: 2026-07-12

## Goal

Serialize every Chelper auth/config publication for one user, make crash recovery reject untrusted or ambiguous state before touching resources, and reject Windows network/device namespaces before import reaches the filesystem service.

## Transaction conflict domain

Chelper uses one per-user global configuration transaction lock rooted below its user data directory. The root is created mode `0700`, canonicalized once, and rejected if it is a symlink or non-directory. One short coordinator serializes inspection, recovery, installation, and retirement of one long-lived main transaction generation. The main generation remains held through auth and config publication, so different auth files sharing one config and different configs sharing one auth cannot overlap.

The global process-local promise queue uses the same single identity. Cross-process ownership remains no-lease: a currently live PID is never removed based on elapsed time. Process-start identity is added only if a reliable cross-platform observation exists; otherwise PID reuse deliberately causes a conservative timeout.

## Trusted metadata and WAL

A complete candidate contains mode-`0600` owner metadata created from trusted fixed-canonical auth/config targets. Owner metadata has exact keys for its version, PID, token, generation, and target pair. It is fsynced before the candidate directory and parent are fsynced and the candidate is atomically renamed to the main generation.

The versioned WAL repeats the owner token, generation, and exact targets. Recovery treats owner metadata as the approved target source and validates the entire WAL before either restore: exact object keys, known version/state, matching token/generation/targets, absolute fixed-canonical targets, known snapshot kinds, canonical base64, integer mode from `0` through `0777`, and bounded encoded/decoded snapshot and journal sizes. Any error is explicit and fail-closed. A non-committed valid WAL restores config before auth; a committed WAL keeps both.

## Fixed-target file operations

Snapshots, sync, internal publication, and restore use no-follow regular-file opens where supported and compare `lstat`, opened-descriptor `fstat`, and a second `lstat`. Each fixed canonical parent remains open and its descriptor fingerprint is checked against the path before temporary-file creation and before and after rename/unlink. Any symlink, device, inode change, or parent change fails closed.

Node 18 has no portable `openat`/`renameat`. These checks detect tested swaps and narrow the race, but they are not claimed to be an absolute directory-anchor guarantee against a malicious same-user process changing the namespace between a verification and pathname operation. The report must preserve this limitation.

The publication callback is only a test scheduling/failure hook. Production config bytes are published by the internal verified atomic primitive; callback code never owns canonical resource I/O.

## Retirement and durability

Only a held global coordinator may retire the main generation. Recovery first removes every recognized journal temporary artifact and fsyncs the generation. Retirement constructs and fsyncs a fresh deterministic metadata-only tombstone, publishes it, fsyncs the parent, revalidates the canonical owner, renames the old generation to a release artifact, fsyncs the parent, deletes the release artifact, and fsyncs again. Secret-bearing or malformed generation contents are never renamed into a permanent tombstone.

Candidate creation, canonical acquisition, release, tombstone publication, and artifact removal fsync their containing directories where supported. Windows directory fsync remains an explicit no-op because Node does not portably support opening/fsyncing directories there; no Windows power-loss durability claim is made.

## Windows import classifier

Windows namespace handling is allowlist-based. Relative local paths, ordinary drive-root paths, consistent extended local-drive paths, and valid consistent `Volume{GUID}` paths are local. UNC, device, named-pipe, `GLOBALROOT`, redirector, malformed volume, and mixed-leading-separator namespace paths are rejected. URL and namespace validation remains before `FSUtil.Service`. Non-Windows POSIX double-slash behavior remains unchanged while backslash Windows network/device spellings remain rejected.

## Tests and verification

Real child-process tests cover same-config/different-auth serialization, WAL crash boundaries, journal-temp crash cleanup, recovery-holder death, and fresh metadata-only retirement. POSIX tests swap a target to a symlink/device during the callback window and require fail-closed behavior without victim mutation. Crafted WAL tables cover every strict field and bound. Namespace durability hooks record the required fsync order. A pure Windows path matrix covers allowed drive/volume paths and rejected network/device/mixed spellings.

Verification runs the complete Chelper suite, build, TypeScript check, fresh npm pack and exact credential scans; focused Opencode tests and typecheck; then Opencode and Desktop builds sequentially. No network, publish, push, or PR is permitted. External credential revocation/rotation remains mandatory and separate.
