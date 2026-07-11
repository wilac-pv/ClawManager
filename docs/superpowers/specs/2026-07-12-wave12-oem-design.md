# Wave 12 OEM Recovery Identity Design

Date: 2026-07-12

## Stable global conflict root

Production resolves the per-user lock root from `os.userInfo().homedir`, not `HOME`, `USERPROFILE`, XDG variables, or the resource pair. Resolution failure is fail-closed. The fixed root must be a real directory, mode `0700` where supported, and on UID platforms owned by `process.getuid()`; symlink, non-directory, and foreign-UID roots are rejected. Tests may pass an internal explicit root through the publication hooks so real child processes remain isolated, but no production environment or CLI override is exposed.

## Owner identity and target semantics

Owner parsing has two phases. The immutable identity phase strictly decodes version, PID, token, generation, and the string-shaped target pair without resolving targets. Lock inspection can therefore recognize a live owner even if its target parent was swapped or became unresolvable, and a live PID always blocks rather than being retired as legacy. Only coordinated dead-owner recovery semantically validates exact fixed-canonical targets. Failure remains explicit with the main generation canonical.

Legacy owner identity hashing reads at most 64 KiB. Oversized or malformed metadata is identified from bounded content plus filesystem identity and size; it is never read without a bound.

## WAL-owned resource temporary files

The prepared WAL is durable before auth/config mutation. Every resource publication temporary file contains the trusted WAL generation and token in an exact prefix: `.<base>.ruying-txn.<generation>.<token>.<uuid>.tmp`. Active and recovery writes use that identity.

After a dead owner's entire owner/WAL validates, coordinated recovery inspects only the two approved resource parents and removes only regular files matching the exact dead generation/token prefix. Symlinks, directories, partial prefixes, other generations, and other tokens are never followed or deleted. Cleanup runs before restore and again after restore so recovery remains idempotent. A child killed after resource-temp fsync and before rename must leave no secret-bearing temp after successor recovery.

## Anchor and callback lifetime

Parent and resource descriptor verification from Wave 11 remains. Transaction release is nested inside an outer `finally`; config-anchor close and auth-anchor close use nested `finally` so both run even if release or the first close fails.

The positional callback remains compatible for existing tests/callers, but its type and parameter are renamed to `ConfigPublicationHook` and `beforeConfigPublication`. It is explicitly a scheduling/failure seam and never owns canonical resource I/O.

## Windows import roots

Windows classification first recognizes unsafe namespace roots. UNC, device, named pipe, `GLOBALROOT`, redirector, and malformed extended namespaces remain rejected. Ordinary drive-local roots are local even when their path body mixes separators or doubles a separator, including `C:\\dir/file` and `C://dir`. Extended drive and valid Volume GUID namespaces remain allowlisted; unsafe namespaces are rejected before filesystem service acquisition.

## Verification and limitations

Real child tests cover divergent HOME/USERPROFILE/XDG with one injected test root, live parent-swap blocking, and fsync-before-rename resource-temp death. Unit coverage proves the production resolver ignores mutable environment values and fails closed on user lookup/root identity errors. Full suites, builds, a fresh npm pack, silent exact-credential scans, and sequential Opencode/Desktop builds are required. No network, publish, push, or PR is permitted. External credential rotation remains mandatory and separate.
