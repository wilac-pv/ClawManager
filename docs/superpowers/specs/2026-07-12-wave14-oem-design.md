# Wave 14 OEM Compatibility Design

## Brand raw input gate

Docs and support URL admission will reject raw `U+0000` through `U+0020`, `U+007F`, `U+2028`, and `U+2029` before WHATWG URL parsing. This prevents silent stripping of raw LF, CR, and tab and excludes prompt-breaking line/paragraph separators. Percent-encoded representations remain valid input. Existing requirements remain: at most 512 UTF-8 bytes, absolute HTTPS, no username/password, and exact original-string return.

Tests cover LF, CR, tab, line separator, and paragraph separator through both Brand accessors and model-visible prompt generation. Prompt output must omit every injected marker and remain bounded.

## Versioned owner and WAL schema

New coordinator and transaction owners use version 2. New transaction WAL records also use version 2. Owner parsing is an exact discriminated union:

- v2 coordinator: immutable version, PID, token, and generation;
- v2 transaction: v2 coordinator identity plus exact targets and parent identities;
- v1 coordinator: historical immutable identity only; and
- v1 transaction: historical immutable identity plus targets retained without semantic validation until after PID fencing.

A live v1 transaction is owned regardless of target semantics, so contenders wait and never retire it. A dead v1 transaction lacks trustworthy parent identity and fails with a clear manual-recovery error before WAL reads or resource mutation. Its canonical main and WAL remain for inspection. A dead v1 coordinator has no resource recovery responsibility and may be retired safely. Only v2 transactions enter automatic WAL recovery with strict target and parent validation.

Real-process tests hold a live v1 transaction while a contender waits, then verify no tombstone. A dead v1 owner and v1 WAL test verifies manual-recovery failure, byte-identical auth/config, and retained canonical owner/WAL. Current crafted fixtures explicitly use v2; dedicated compatibility fixtures explicitly use v1.

## Documentation and verification

Chelper documentation will state current v2 shapes and dead-v1 manual recovery. The preserved Wave 13 report will receive an explicit Wave 14 correction noting that required parent fields were initially added without a version bump, followed by Wave 14 RED/GREEN evidence. Verification includes fresh focused/full tests, package-local typechecks, builds, changed-file secret scans, and diff checks. No network, publish, or external credential rotation is performed; administrator rotation remains mandatory.
