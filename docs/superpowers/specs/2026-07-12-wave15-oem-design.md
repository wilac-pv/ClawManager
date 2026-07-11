# Wave 15 OEM Compatibility Design

## Unicode URL admission

Brand docs/support URL admission rejects every raw character in Unicode general categories `Cc`, `Cf`, or `Z` before WHATWG parsing. This supersedes the finite Wave 14 code-point list while retaining HTTPS-only, no-credentials, 512 UTF-8 byte, and exact-original-string rules. Percent-encoded representations remain valid because they contain no raw forbidden character.

Brand and prompt tests cover U+0085, U+00A0, U+2000, U+200B, U+2066, and U+FEFF in addition to the prior controls. Each raw marker is omitted from model-visible output; percent-encoded equivalents are preserved exactly.

## Historical v1 shapes

The exact owner union recognizes both shipped v1 transaction shapes: identity plus targets, and Wave 13 identity plus targets and parents. Targets and parents remain untrusted values until PID/version disposition. Extra, missing, or mixed keys remain invalid.

When either exact v1 shape has a live PID, current Chelper immediately refuses configuration with guidance to wait for the older process to exit and retry. It does not validate target semantics, wait, retire, create a tombstone, or alter owner bytes. A dead v1 transaction of either shape requires manual recovery before any WAL read or mutation. Tests compare owner, WAL, auth, and config raw bytes before and after failure and require the canonical main to remain.

## Upgrade rule

Different Chelper versions must never overlap during login/configuration. Operators stop all older login/configuration processes before upgrading, install one current package, and then retry with only that version. The current reader can detect a live v1 owner and refuse, but cannot make an already-running old reader understand v2. No dual write or v2-to-v1 downgrade is safe.

Package audit verifies the distributed file list contains one current `dist/index.js` reader plus the postinstall script, not side-by-side legacy readers. Operator documentation and the final report state this limitation and workflow explicitly.

## Verification

Implementation follows strict RED to GREEN. Fresh Brand/system tests, package-local typechecks, Chelper focused/full tests, builds, distribution audit, diff checks, and changed-file credential scans are required. No network, publish, or external credential rotation occurs; administrator rotation remains mandatory.
