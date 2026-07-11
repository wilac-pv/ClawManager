# Wave 13 OEM Hardening Design

## Scope

Wave 13 closes the remaining bounded-input and recovery-identity gaps in the Ruying Code OEM work. It changes Brand URL admission in the primary repository and global configuration publication in `aicoding-helper`. It does not publish packages, access the network, or rotate credentials.

## Brand URL admission

`Brand.docsURL()` and `Brand.supportURL()` will share one internal validator. The validator reads the selected environment value once and returns the original string only when all of these conditions hold:

- its UTF-8 encoding is at most 512 bytes;
- it parses as an absolute URL;
- its scheme is exactly `https:`; and
- it contains neither a username nor a password.

Invalid or oversized values are omitted by returning `undefined`. The validator does not normalize or rewrite an accepted value. Tests cover malformed and HTTP values, credentials, exact 512-byte acceptance, 513-byte rejection, and a 20,000-character prompt-injection value. The prompt test proves the attacker-controlled content is absent and the model-visible system prompt remains bounded.

## Durable parent identity

The helper will open and retain verified parent-directory anchors for the auth and configuration targets before publishing the transaction-lock owner. Each anchor identity comes from `lstatSync(path, { bigint: true })`; `dev` and `ino` are persisted as strictly validated, canonical decimal strings in both the owner record and WAL.

Recovery validates the complete owner and WAL, opens verified anchors for the current parent paths, and compares their identities exactly with the persisted values before any resource mutation. A missing or mismatched identity fails closed. Descriptors are closed on every exit path.

A real child-process integration test will crash after WAL publication. The parent test then renames the original resource directory, creates a replacement directory at the same pathname with victim content, and attempts recovery. Recovery must fail, and a before/after byte comparison must show the replacement directory is unchanged.

## Bounded file reads

Owner, WAL, and snapshot reads will use one bounded descriptor reader. It allocates at most `maximum + 1` bytes, reads only until EOF or that bound, and rejects when the observed length exceeds the configured maximum. Existing size checks may remain as fast rejection paths, but correctness does not depend on a pre-read size observation and no read runs to unbounded EOF.

Deterministic tests will use a narrow synchronous callback at the verified-open/read boundary to grow each file after its size was observed. Owner, WAL, and snapshot cases must reject overflow. The callback is test support only: it runs synchronously after descriptor identity verification and before the bounded read, and exceptions propagate without resource mutation.

## Production root selection evidence

Root path selection will be exposed as a production pure function that derives the path from `os.userInfo().homedir`. The existing resolver creates and validates exactly that selected path.

Independent child processes will call this production selector with divergent `HOME`, `USERPROFILE`, and XDG environment variables and without an injected lock root. They must report the same path. Because the selector is pure, this evidence leaves no persistent artifact. The final report will describe this accurately as evidence for production root selection, not as live cross-process lock acquisition at the actual user root.

## Documentation and verification

The operator documentation and review report will state:

- Brand URL HTTPS, credential, and 512-byte admission rules;
- owner, WAL, and snapshot size limits;
- publication and bounded-read callback timing and exception behavior;
- exact target and parent-identity requirements for recovery;
- the limited production resolver child-process claim; and
- external credential rotation as a separate operational action.

Implementation follows strict RED to GREEN cycles. Completion requires fresh focused and full tests, package-local typechecks, build, secret scans, and committed review-stage history. No generated source will be edited directly.
