# Final OEM Fix Report

Date: 2026-07-11

Primary review range: `da9a3097b660..6b1cac5054dc14899a21d71e66b441813eeb3c9d`

Repositories:

- Primary: `/Users/gwm/data/gitee/opencode/.worktrees/ruying-code-oem` (`ruying-code-oem`)
- Chelper: `/Users/gwm/data/github/aicoding-helper` (`main`)

## Outcome

All confirmed Critical and Important findings were fixed. Both bounded Minor findings were also fixed. No public Protocol or Server `HttpApi` schema changed, so client/SDK regeneration was not required. No npm publish was performed and tests did not contact production GWM endpoints.

## Finding dispositions

1. **Confirmed and fixed — provider isolation.** Added a typed Ruying-provider invariant at the model-execution boundary and explicit request validation for session prompt, async prompt, command, init, and summarize handlers. HTTP violations return 400. Tests configure a realistic second provider and verify rejection at both HTTP and direct execution boundaries.
2. **Confirmed and fixed — migration bypass and legacy Desktop state.** Moved default OEM migration into shared `Server.listen()` initialization so Desktop and CLI both run it before data layers open. Desktop now supplies an explicit legacy Bundle-ID source to the sidecar. Direct-server and Desktop-path regression tests cover the behavior.
3. **Confirmed and fixed — empty SSO identity.** Session status now requires a non-empty, trimmed `employeeId`; empty build-patch values are omitted; callbacks reject an empty employee identity. The prior empty-marker acceptance expectations were reversed.
4. **Confirmed and fixed — swallowed publication failure.** Callback publication failures now fail the callback. Cancellation restores config owned by the failed attempt and safely handles a rejected publication promise. Best-effort model-list behavior remains unchanged.
5. **Confirmed and fixed — branded inline env.** Added branded-first `RUYING_CODE_AUTH_CONTENT` and `RUYING_CODE_CONFIG_CONTENT` reads with legacy fallback. Related tests prove branded precedence and legacy compatibility.
6. **Confirmed and fixed — concurrent first-launch race.** Copy-time target collisions recheck the target and are treated as a successful concurrent migration. A 16-way race test covers this.
7. **Confirmed and fixed in chelper — XDG config root.** Config discovery and writes honor `XDG_CONFIG_HOME`, falling back to `HOME/.config`; auth remains under the corresponding XDG data rules.
8. **Confirmed and fixed — public OEM exits/branding.** Centralized optional internal docs/support URLs in `Brand`; hidden docs/help controls when no internal URL exists; removed the public GitHub crash exit and copy a plain internal report; branded Desktop onboarding as `New Ruying Code Project`.
9. **Confirmed and fixed — model-dialog behavior.** The dialog defensively filters providers to Ruying and a behavior-level test supplies mixed realistic provider state and verifies that only Ruying is visible and no provider-connect path is exposed.
10. **Confirmed and fixed — Solid wiring coverage.** Extracted the production context/SDK controller wiring and added browser-condition lifecycle coverage for readiness, subscription replacement, authorize/callback/dispose/reload. Existing user-controller tests retain logout-failure coverage.
11. **Confirmed and fixed in chelper — recovery/selective migration coverage.** Added gateway reject/empty/success, JSON/JSONC precedence, exact legacy GWM-provider cleanup, parse-failure no-mutation, and config/auth ordering cases.
12. **Reviewed; no history rewrite.** The range is 272 files (`8015` insertions, `1837` deletions) but its 52 conventional commits are dependency ordered: brand/path foundations, migration, SSO/provider lock, TUI/App/Desktop surfaces, then packaging. Rewriting or squashing would reduce auditability and was neither technically necessary nor authorized.
13. **Confirmed and fixed in chelper — atomic config writes.** Config writes now use a mode-preserving temporary-file-and-rename path, reject unsafe symlink targets, and publish config before auth. Tests cover permissions and symlinks.
14. **Confirmed and fixed — Desktop debug exports.** Added branded zip names and gathers logs from current and legacy XDG/user-data roots. The path policy has direct tests.

## RED evidence

- Empty identity/publication rollback: focused plugin tests failed before the implementation because an empty marker produced an authenticated object and failed config publication still returned success/left config behind.
- Migration: focused tests reproduced both a concurrent copy `EEXIST` and an `ENOENT`/missing-state path when `Server.listen()` was called directly.
- Inline env: the new precedence test observed legacy content when branded content was set.
- Support/branding: the new tests initially failed because `Brand.docsURL` did not exist and source/behavior checks still found public upstream exits and `New OpenCode Project`.
- TUI provider dialog: the new behavior test initially failed because the OEM filtering seam was absent.
- Desktop logging: the new test initially failed with the logging-path module missing.
- Chelper XDG/atomic behavior: focused tests initially reproduced an XDG path `ENOENT` and observed a newly written config mode of `0644` instead of preserved `0600`.
- Provider isolation was independently confirmed in code: HTTP handlers accepted arbitrary configured model provider IDs after only checking Ruying login. The newly added configured-secondary-provider regression is GREEN below. The combined pre-fix test command stopped on the earlier plugin RED failures before reaching this new HTTP case, so no fabricated pre-fix HTTP result is claimed.

## GREEN verification

Primary focused regression suites:

```text
packages/opencode$ bun test test/auth/auth.test.ts test/auth/ruying-gate.test.ts test/migration/oem.test.ts test/plugin/ruying.test.ts --timeout 30000
71 pass, 0 fail

packages/opencode$ bun test test/server/httpapi-sdk.test.ts -t 'ruying|secondary provider' --timeout 30000
7 pass, 0 fail

packages/tui$ bun test test/component/dialog-model-oem.test.ts test/public-copy.test.ts
10 pass, 0 fail

packages/app$ bun test --conditions=browser src/components/ruying-wiring.test.ts src/components/ruying-login.test.ts src/components/ruying-user.test.ts src/i18n/i18n.test.ts
30 pass, 0 fail

packages/desktop$ bun test src/main/migrate.test.ts src/main/logging-paths.test.ts
17 pass, 0 fail

packages/core$ bun test test/brand.test.ts
10 pass, 0 fail
```

Primary type checking and builds:

```text
packages/core$ bun typecheck
pass
packages/opencode$ bun typecheck
pass
packages/tui$ bun typecheck
pass
packages/app$ bun typecheck
pass
packages/desktop$ bun typecheck
pass

packages/app$ bun run build
pass
packages/desktop$ bun run build
pass
packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed: 0.0.0-ruying-code-oem-202607111435
```

Chelper:

```text
$ npm test -- --run
24 pass, 0 fail
$ npm run build
pass
$ npx tsc --noEmit
pass
$ git diff --check
pass
```

Primary whitespace/history check:

```text
$ git diff --check HEAD~3..HEAD
pass
```

## Commits

Primary:

- `d9eec7d66d5975f5b5905eda6265ea7b4d86c64e` — `fix(opencode): enforce ruying execution security`
- `a321fd7e7cc5533b6f3e49c8cd03cdb069f05a39` — `fix(desktop): migrate before server startup`
- `b325a45842b30706c6d962b47635ec7b75df766c` — `fix(app): harden ruying OEM surfaces`

Chelper:

- `5697acab027cc926dd079b2da5487da11c8f488e` — atomic/XDG-safe configuration and expanded recovery coverage

## Remaining concerns

- App/Desktop production builds still emit their pre-existing Vite chunking/dynamic-import/eval warnings; builds succeed and this patch did not introduce a new failure.
- The three newly required reveal-menu i18n keys use the English fallback in non-English locale files to keep locale parity; native translations can be supplied separately.
- Chelper's unrelated untracked `.serena/` directory was preserved unchanged.

---

# Wave 2 Re-review Fixes

Date: 2026-07-11

Contract: `.superpowers/sdd/final-rereview-findings.md`

Wave 2 changed only the primary OEM worktree. The chelper repository and its unrelated `.serena/` directory were not modified.

## Wave 2 dispositions

1. **Confirmed and fixed — authoritative login at the shared LLM boundary.** `LLM.run` now checks the Ruying provider and authoritative Ruying session before logging or touching provider, config, language-model, or client work. The check uses the `Auth` and `Config` services captured by the LLM layer. Direct service tests prove both credential-only Ruying and a secondary provider are rejected without a provider touch. A real project-copy HTTP test proves credential-only name generation makes zero fake-LLM calls.
2. **Confirmed and fixed — cross-process/atomic migration.** Each migration now claims an atomic lock file with PID/token ownership, waits across processes, recovers dead owners, and releases only its own token. Missing files and directories are copied to a unique sibling temporary path and atomically renamed, so public targets never expose partial copies. Completion is determined by a successful marker written under the lock, never merely by target existence. Tests cover partial visibility, 16 same-process callers, eight subprocesses, dead-owner recovery, temp cleanup, and marker safety.
3. **Confirmed and fixed — malformed config publication.** Invalid JSONC and non-object JSON now throw `RuyingConfigPublicationError`. Real OAuth callback tests verify a failed callback and unchanged source, so no credential result or config commit is returned.
4. **Confirmed and fixed — shared server bootstrap.** `Server.Default().app.fetch`, `.request`, and `Server.listen` await a shared, retryable, once-only bootstrap before constructing the in-process handler or listener layers. Explicit Desktop roots have independent bootstrap keys.
5. **Confirmed and fixed — remaining public exits.** Desktop menu, both settings implementations, the development `HelpButton`, and the error-page support control now consume optional `Brand.docsURL()`/`Brand.supportURL()` only. Controls are absent without internal URLs. The error page uses neutral internal-support copy, and the menu no longer exposes upstream docs, Discord, or GitHub feedback URLs.
6. **Confirmed test gap and fixed — mounted DialogModel coverage.** The helper-only test was replaced by a real OpenTUI `DialogModel` + `DialogSelect` mount with realistic mixed providers/favorites/recents. The captured frame proves secondary favorites, recents, provider labels, and connect copy are absent.
7. **Confirmed test gap and fixed — mounted RuyingGate/RuyingLogin coverage.** A bounded Bun preload invokes the repository's production `vite-plugin-solid` transform so the actual Solid components can mount in Happy DOM. Tests cover checking, error, logged-out, logged-in, protected-child gating, retry, and the real login button's authorize/callback/dispose/reload chain. Only leaf `Button`/`Splash` UI widgets are substituted.
8. **Confirmed and fixed with finding 1.** Direct LLM service tests assert missing SSO and secondary-provider errors before any provider-language/provider-metadata access.
9. **Confirmed test gap and fixed — Desktop handoff contract.** A shared `sidecar-contract` is used by the server sender and sidecar receiver. The test starts with `legacyElectronDataPath`, round-trips the start command, and verifies the exact legacy Bundle-ID root becomes `Server.listen(...).legacyStateRoot`. The opencode direct-listen migration test proves that root reaches branded state.
10. **Confirmed and fixed — optional error support.** The error-page support button is hidden without `SUPPORT_URL` and is labeled `联系内部支持` when present; Discord branding/iconography was removed.
11. **No history rewrite.** Existing Wave 1 history and the dependency-ordered OEM history were not split, rewritten, or squashed. Wave 2 functionality was landed as three new coherent conventional commits, preserving auditability and user authorization boundaries.

No public Protocol or Server `HttpApi` schema changed, so generated clients/SDKs were not regenerated. No publish was performed and tests did not contact production GWM endpoints.

## Wave 2 RED evidence

```text
packages/opencode$ bun test test/auth/ruying-gate.test.ts --timeout 30000
RED: missing-SSO direct LLM test died with "provider language touched" instead of RuyingLoginRequiredError; 1 fail.

packages/opencode$ bun test test/server/httpapi-sdk.test.ts -t 'project copy name generation' --timeout 30000
RED with the login boundary reverted: expected fake LLM calls 0, received 1.

packages/opencode$ bun test test/migration/oem.test.ts -t 'partially' --timeout 30000
RED: expected partial=false, received true while the public directory was copied.

packages/opencode$ bun test test/migration/oem.test.ts -t 'Desktop legacy-state' --timeout 30000
RED: ENOENT for branded session.db after default marker completion suppressed the explicit Desktop source.

packages/opencode$ bun test test/migration/oem.test.ts -t 'Server.Default' --timeout 30000
RED: ENOENT for branded legacy.json after the first in-process request.

packages/opencode$ bun test test/migration/oem.test.ts -t 'abandoned process lock' --timeout 30000
RED with abandoned-lock recovery disabled: expected lock existence false, received true.

packages/desktop$ bun test src/main/migrate.test.ts -t 'sidecar listen contract'
RED: Cannot find module './sidecar-contract'.

packages/opencode$ bun test test/plugin/ruying.test.ts -t 'without credential or config commit' --timeout 30000
RED: malformed JSONC and non-object JSON both returned OAuth success with key/metadata; 2 fail.

packages/app$ bun test --preload ./happydom.ts src/desktop-menu.test.ts src/public-exits.test.ts
RED: createDesktopMenu export missing; source audit found opencode.ai, Discord, and GitHub exits.

packages/tui$ bun test test/component/dialog-model-oem.test.tsx --timeout 30000
RED with the production provider filter reverted: captured frame showed Favorite Leak, Recent Leak, and Secondary Connect Provider.

packages/app$ bun test --conditions=browser --preload ./happydom.ts src/components/ruying-wiring.test.tsx
RED: actual JSX mount exposed that the prior unit runner had no Solid transform (`React is not defined`), proving the controller-only harness could not render production components. The bounded production-transform preload resolved the test seam.
```

## Wave 2 GREEN verification

Focused tests:

```text
packages/opencode$ bun test test/auth/auth.test.ts test/auth/ruying-gate.test.ts test/migration/oem.test.ts test/plugin/ruying.test.ts --timeout 30000
80 pass, 0 fail

packages/opencode$ bun test test/server/httpapi-sdk.test.ts -t 'ruying|secondary provider|project copy name generation' --timeout 30000
8 pass, 0 fail

packages/tui$ bun test test/component/dialog-model-oem.test.tsx test/public-copy.test.ts --timeout 30000
4 pass, 0 fail

packages/app$ bun test --conditions=browser --preload ./solid-test-preload.ts --preload ./happydom.ts src/components/ruying-wiring.test.tsx src/components/ruying-login.test.ts src/components/ruying-user.test.tsx src/desktop-menu.test.ts src/public-exits.test.ts src/i18n/parity.test.ts --timeout 30000
36 pass, 0 fail

packages/desktop$ bun test src/main/migrate.test.ts src/main/logging-paths.test.ts
10 pass, 0 fail

packages/core$ bun test test/brand.test.ts
10 pass, 0 fail
```

Five package typechecks:

```text
packages/core$ bun typecheck
pass
packages/opencode$ bun typecheck
pass
packages/tui$ bun typecheck
pass
packages/app$ bun typecheck
pass
packages/desktop$ bun typecheck
pass
```

Builds and checks:

```text
packages/app$ bun run build
pass
packages/desktop$ bun run build
pass
packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed: 0.0.0-ruying-code-oem-202607111520

$ git diff --check HEAD~3..HEAD
pass
```

The App/Desktop builds retain their pre-existing Vite dynamic-import/chunk-size/eval/script warnings; all three builds exited successfully.

## Wave 2 commits

- `8c206b79c4b408bcbd2f36409a69beb0060236d6` — `fix(opencode): harden ruying authorization`
- `d3599db6677712ccbe5cf07a5917becf05d3bb40` — `fix(opencode): make OEM migration atomic`
- `09297001ec0bad5dddcd485293c8240eeb83f872` — `fix(app): remove upstream OEM exits`

---

# Wave 3 Re-review Fixes

Date: 2026-07-11

Contract: `.superpowers/sdd/final-rereview-findings-wave3.md`

## Wave 3 dispositions

1. **Confirmed and fixed — production WSL package, binary, and launch path.** Desktop now installs the exact Desktop version of `@ruying/ruying-code` with npm using only `https://nexus.gwm.cn/repository/npm-group/`, probes for npm instead of curl, resolves only the `ruying-code` executable, and launches that resolved path. The upstream curl installer and `$HOME/.opencode/bin/opencode` resolution were removed. Internal `OPENCODE_SERVER_*`, `OPENCODE_CLIENT`, and file-watcher variables remain because they are the existing server compatibility protocol, not distribution channels.
2. **Confirmed and fixed — migration ownership.** The PID-only custom lock was removed completely. Migration now uses the repository's established heartbeat/token-aware `Flock` with an explicit adjacent lock directory, token-checked release, stale heartbeat/breaker recovery, and exclusive same/cross-process serialization.
3. **Confirmed and fixed — marker validation.** Only a regular JSON marker with `version: 1` and string-array `copied`/`skipped` fields completes migration. Empty, malformed, non-object, or wrong-version markers are removed under the lock and retried; marker symlink/directory safety remains intact.
4. **Confirmed and fixed — runtime system/provider identity.** Every `SystemPrompt.provider` branch passes through one Ruying branding boundary. Runtime prompts identify Ruying Code and contain no OpenCode docs/GitHub fallback. Optional docs/support text comes only from configured Brand resources. Provider integration headers, origins, user agents, and credential guidance use Brand identity and no `opencode.ai` referer.
5. **Confirmed and fixed — public resources.** Changelog retrieval is disabled unless an OEM changelog URL is explicitly configured. Web and Desktop notifications no longer load an upstream favicon. When the embedded UI is unavailable, the server returns a local 404 and never contacts `app.opencode.ai`; embedded assets and authorization middleware continue to work.
6. **Confirmed and fixed — Chelper auth-failure transaction.** Chelper prepares the complete config content in memory, then requires serialized atomic auth publication to succeed before publishing config. Malformed/non-object auth failures leave both auth and the existing JSONC config byte-for-byte unchanged.
7. **Confirmed and fixed — orphan cleanup/crash recovery.** After lock acquisition and before a retry, migration recursively removes only recognized `.<target>.<pid>.<uuid>.tmp` artifacts. A real child process is killed while the real `fs.cp` promise is held before publication; the next process recovers the stale Flock lease, removes the orphan directory, and completes all 800 files.
8. **Bounded coverage strengthened.** The production Desktop launcher adapter is exercised through the real WSL server controller to the sidecar spawn boundary; only the unavailable OS `wsl` process is substituted. The actual `logoutRuying` transaction is followed by a same-session LLM continuation, which fails authorization with zero post-logout provider touches. Full Electron `index.ts` is not imported because doing so executes application startup; no claim of a real WSL process launch on macOS/CI is made.

No public Protocol or Server `HttpApi` schema changed, so generated clients/SDKs were not regenerated. No package was published and no test contacted production GWM or public upstream distribution endpoints.

## Wave 3 RED evidence

```text
packages/desktop$ bun test src/main/wsl/runtime-contract.test.ts
RED: expected Nexus registry/package contract; runtime still contained https://opencode.ai/install and $HOME/.opencode/bin/opencode. 1 fail.

packages/opencode$ bun test test/migration/oem.test.ts -t 'completion marker is invalid|recognized orphan' --timeout 30000
RED: three invalid markers suppressed migration and one recognized orphan remained. 4 fail.

packages/opencode$ bun test test/session/system.test.ts -t 'brands every provider' --timeout 30000
RED: provider branches emitted OpenCode identity and upstream docs/GitHub URLs.

packages/opencode$ bun test test/provider/oem-identity.test.ts
RED: provider integrations lacked Brand identity and contained upstream referers/titles/UAs. 1 fail.

packages/opencode$ bun test test/server/httpapi-ui.test.ts -t 'without contacting a public fallback' --timeout 30000
RED: missing embedded UI proxied to https://app.opencode.ai instead of returning 404.

packages/app$ bun test src/public-exits.test.ts
RED: changelog and notification sources contained https://opencode.ai resources. 1 fail.

chelper$ npm test -- --run src/tools/configurer.test.ts -t 'preserves invalid auth content'
RED: all three invalid-auth cases changed the existing JSONC config before auth failed. 3 fail.
```

The authenticate/logout continuation and Desktop launcher handoff were coverage findings for already intended boundaries; their new tests passed after the bounded harness was established, so no pre-fix behavior failure is claimed. The first parallel final sweep produced one blank OpenTUI frame under concurrent build/test load; the unchanged mounted test passed 4/4 immediately in isolation. No production change was made for that environmental timing observation.

## Wave 3 GREEN verification

Fresh typechecks:

```text
packages/core$ bun typecheck
pass
packages/opencode$ bun typecheck
pass
packages/tui$ bun typecheck
pass
packages/app$ bun typecheck
pass
packages/desktop$ bun typecheck
pass
```

Focused primary tests:

```text
packages/opencode$ bun test test/auth/auth.test.ts test/auth/ruying-gate.test.ts test/migration/oem.test.ts test/plugin/ruying.test.ts test/session/system.test.ts test/provider/oem-identity.test.ts test/server/httpapi-ui.test.ts test/script/verify-ruying-package.test.ts test/script/publish-ruying.test.ts --timeout 30000
131 pass, 0 fail

packages/opencode$ bun test test/server/httpapi-sdk.test.ts -t 'ruying|secondary provider|project copy name generation' --timeout 30000
8 pass, 0 fail

packages/tui$ bun test test/component/dialog-model-oem.test.tsx test/public-copy.test.ts --timeout 30000
4 pass, 0 fail (isolated rerun after one parallel blank-frame observation)

packages/app$ bun test --conditions=browser --preload ./solid-test-preload.ts --preload ./happydom.ts src/components/ruying-wiring.test.tsx src/components/ruying-login.test.ts src/components/ruying-user.test.tsx src/desktop-menu.test.ts src/public-exits.test.ts src/wsl/settings-model.test.ts src/i18n/parity.test.ts --timeout 30000
47 pass, 0 fail

packages/desktop$ bun test src/main/wsl/runtime-contract.test.ts src/main/wsl/servers.test.ts src/main/migrate.test.ts src/main/logging-paths.test.ts
24 pass, 0 fail

packages/core$ bun test test/brand.test.ts
11 pass, 0 fail
```

Chelper:

```text
$ npm test -- --run
24 pass, 0 fail
$ npm run build
pass
```

Builds/package checks:

```text
packages/app$ bun run build
pass
packages/desktop$ bun run build
pass
packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed: 0.0.0-ruying-code-oem-202607111605

packages/opencode$ bun test test/script/verify-ruying-package.test.ts test/script/publish-ruying.test.ts --timeout 30000
22 pass, 0 fail (included in the 131-test command; no publish/network execution)
```

App/Desktop/OpenCode builds retain the repository's existing Vite dynamic-import, duplicate sourcemap, and chunk-size warnings; all builds exited 0.

## Wave 3 commits

Primary:

- `2fe0c1cff` — `fix(desktop): use Ruying WSL runtime`
- `6a0c33b63` — `fix(opencode): recover OEM migration safely`
- `387bd5ec8` — `fix(opencode): remove upstream OEM resources`
- `28d5146d7` — `test(opencode): cover logout continuation`
- `eb6c65dac` — `test(desktop): cover WSL sidecar handoff`

Chelper:

- `2dc3d8a` — `fix(opencode): publish auth before config`

## Wave 3 remaining concerns

- Existing Vite build warnings remain as described above; they did not fail builds.
- One mounted OpenTUI frame was blank only while seven test suites ran concurrently; the same unchanged test passed immediately in isolation. This is reported as a test-environment timing observation, not hidden as a full parallel-pass claim.
- Chelper's unrelated untracked `.serena/` directory remains preserved.

## Wave 4 fixes

- Removed plaintext/query bearer-token introspection from both the Ruying plugin and Chelper. The authenticated HTTPS provisioning response is now the sole identity source; existing local keys are not trusted when provisioning is unavailable.
- Hard-disabled public session sharing at the SessionShare and ShareNext boundaries. Auto-share is normalized to disabled, direct create/request calls fail before HTTP, migrated share URLs are not projected, and local share records are deleted without a remote delete. Public Console/GitHub/Import and `run --share` CLI exposure was removed.
- Made WSL npm installation use the user-owned `$HOME/.local` prefix and reject Windows-mounted `/mnt/*` command resolution after PATH sanitization.
- Restricted orphan cleanup to `.ruying-oem-migration-v1.*.tmp` artifacts created by this migration, preserving unrelated temporary files.
- Serialized Chelper auth/config publication and restored exact prior auth bytes, mode, and symlink target semantics when config publication fails. Removed public OpenCode schema injection from Chelper and runtime/TUI config generation.
- Branded ACP identity and terminal login metadata from Brand using the real `ruying-code login` flow.
- Removed public subscription/workspace retry actions, the migrated-project public favicon fallback, active-account remote config loading, and account-backed experimental console operations. Compatibility console endpoints now return local/empty state without account transport calls.
- Updated WSL UI copy across every locale and executable WSL status copy to Ruying Code.

## Wave 4 RED evidence

```text
packages/opencode$ bun test test/plugin/ruying.test.ts
RED: source still contained DEFAULT_CHECK_TOKEN_URL / verifyAccessToken and query bearer introspection.

chelper$ npm test -- --run src/commands/login-security.test.ts
RED: login still contained CHECK_TOKEN_URL / checkToken / legacy direct provisioning.

packages/opencode$ bun test test/share/session-disabled.test.ts
RED: SessionShare still honored auto-share and Session.fromRow projected a migrated opncd.ai URL. 2 fail.

packages/desktop$ bun test src/main/wsl/runtime-contract.test.ts
RED: global install lacked a user prefix and resolver did not reject /mnt paths.

packages/opencode$ bun test test/migration/oem.test.ts -t 'removes only'
RED: generic UUID temporary matching deleted an unrelated file.

chelper$ npm test -- --run src/tools/configurer.test.ts
Failure injection exposed incomplete rollback: bytes restored but prior 0640 mode became 0600. Fixed before GREEN.
```

## Wave 4 GREEN verification

```text
packages/opencode$ bun test test/plugin/ruying.test.ts
52 pass, 0 fail

packages/opencode$ bun test test/share/session-disabled.test.ts test/share/share-next.test.ts
4 pass, 0 fail

packages/opencode$ bun test test/migration/oem.test.ts
20 pass, 0 fail

packages/opencode$ bun test test/config/config.test.ts test/session/retry.test.ts test/oem/public-exits.test.ts
137 pass, 0 fail

packages/opencode$ bun typecheck
pass

packages/desktop$ bun test src/main/wsl/runtime-contract.test.ts src/main/wsl/servers.test.ts
14 pass, 0 fail
packages/desktop$ bun typecheck
pass

packages/app$ bun test src/wsl/settings-model.test.ts src/public-exits.test.ts
13 pass, 0 fail
packages/app$ bun typecheck
pass

chelper$ npm test -- --run src/tools/configurer.test.ts src/commands/login-security.test.ts
21 pass, 0 fail
chelper$ npm run build
pass

chelper$ npm test -- --run
27 pass, 0 fail

packages/app$ bun test src/public-exits.test.ts src/i18n/parity.test.ts
7 pass, 0 fail

packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed
packages/app$ bun run build
pass
packages/desktop$ bun run build
pass on sequential rerun after the first parallel run raced the OpenCode dist directory replacement

packages/opencode$ bun test test/script/verify-ruying-package.test.ts test/script/publish-ruying.test.ts --timeout 30000
22 pass, 0 fail; no publish/network execution
```

## Wave 4 commits

Primary:

- `5c07c1d78` — `fix(opencode): secure SSO provisioning`
- `5315184a7` — `fix(opencode): disable public sharing`
- `f087a6f9e` — `fix(desktop): harden WSL installation`
- `651ac105a` — `fix(oem): remove upstream service exits`
- `34a3694ac` — `fix(app): brand WSL locale copy`

Chelper:

- `dcbf1c8` — `fix(login): secure SSO provisioning`
- `a9c7ae7` — `fix(config): rollback failed publication`

---

# Wave 5 Re-review Fixes

Date: 2026-07-12

## Wave 5 dispositions

- Removed the hard-coded legacy NewAPI administrator bearer and the entire unused gateway management API from Chelper. The SSO callback now binds only to `127.0.0.1`, uses a fresh 192-bit callback path per attempt, and documents SSH loopback forwarding for remote use instead of exposing a LAN bearer callback.
- Serialized Chelper publication by canonical auth target, awaited asynchronous config publication, and preserved rollback ordering across concurrent output targets.
- Preserved public-share revocation material locally without automatic remote deletion, disabled public share projection, and added explicit manual-revocation guidance.
- Restricted WSL npm discovery to Linux paths and rejected `/mnt/*` executables.
- Branded the built-in customization skill, MCP OAuth client metadata, Ruying gateway User-Agent, ACP identity, CLI help, and TUI tips. MCP `client_uri` is omitted unless an internal documentation URL is explicitly configured.
- Restored the local-file import command while removing URL/share transport and network access.
- Updated the active help snapshots and strengthened OEM public-exit audits.

## Wave 5 RED evidence

- Chelper callback tests found all-interface binding, a predictable callback path, and a LAN redirect URL.
- Chelper transaction interleaving reproduced a config failure that incorrectly resolved while a second publication was queued.
- Share tests proved disabled removal either destroyed revocation material or left it only in cascading storage.
- WSL contract tests found mounted Windows npm discovery and a fixed Linux-only PATH.
- Built-in skill, MCP metadata, init/help, import, and TUI audits found upstream product names, public sharing tips, and URL/share import transport.
- Fresh ACP initialization and help snapshot tests found stale OpenCode identity and removed/changed command surfaces.

## Wave 5 GREEN verification

```text
chelper$ npm test -- --run src/commands/login-security.test.ts src/tools/configurer.test.ts
24 pass, 0 fail
chelper$ npm run build
pass

packages/opencode$ focused ACP/help/MCP/import/share/OEM tests
25 pass, 0 fail; 29 help snapshots
packages/core$ bun test test/plugin/skill.test.ts
1 pass, 0 fail
packages/tui$ bun test test/public-copy.test.ts
3 pass, 0 fail
packages/app$ bun test src/public-exits.test.ts
3 pass, 0 fail
packages/desktop$ bun test src/main/wsl/runtime-contract.test.ts
1 pass, 0 fail

packages/core|opencode|tui|app|desktop$ bun typecheck
pass in all five packages
```

The Wave 5 credential scan covered Chelper production source, current `dist`, and a newly packed artifact. Wave 6 subsequently found that this scope was incomplete: the exact credential also remained in a tracked design document and four ignored stale package archives. Wave 6 closes that gap below; this report does not misstate the earlier scan as a full-tree result.

## Wave 5 commits

Primary:

- `a90bcb96b` — `fix: close final OEM security gaps`

Chelper:

- `7ea74e2` — `fix(security): remove legacy admin access`

---

# Wave 6 Re-review Fixes

Date: 2026-07-12

## Wave 6 dispositions

- Redacted the exact former administrator credential from the tracked Chelper design document. Deleted only the four identified ignored stale `.tgz` archives containing it. Preserved the unrelated `.serena/` tree and all other ignored/unrelated files.
- Added a generated database migration and durable `share_revocation_quarantine` table with no cascading Session foreign key. Existing `session_share` rows are moved transactionally and removed from cascading storage; runtime migration is idempotent and preserves first-quarantined material on ID conflicts.
- Added a bounded local administrator workflow: `ruying-code db share-quarantine list` displays only safe ID/session/time metadata; `export <file>` creates a new local file exclusively with mode `0600`; `complete <id> --confirmed` removes only the local record after manual remote revocation. None of these paths makes a public request, and ordinary output never displays or logs the secret.
- Reworked WSL PATH handling to preserve inherited Linux entries such as nvm, Volta, asdf, `/opt`, and snap while filtering lexical `/mnt` entries. The sanitizer invokes system tools by absolute Linux paths so a hostile or Windows-only inherited PATH cannot replace the filtering utilities. Wave 6 did not canonicalize symlinked command paths before the mounted-path check; Wave 7 closes that gap.
- Branded the Opencode `/init` template and the updater/settings locale subset as Ruying Code, and removed the unsupported `$schema` TUI tip. This did not cover the separate Core/V2 init template or every other visible locale value; Wave 7 expands the audit. Wave 6 behavior covered callback-path generation, local import validation, and the direct User-Agent function, not callback response handling or captured request headers.

## Wave 6 RED evidence

- The credential audit found one tracked Chelper design-document match and four ignored stale package matches. It did not include ignored review-diff scratch files in the primary worktree; Wave 7 scans and removes the two credential-bearing review artifacts generated by later re-review work.
- The first durable-share test found no `share_revocation_quarantine` table; the next test showed disabled initialization left the legacy cascading row in place. The admin workflow test then failed because safe list/export/confirmed-complete operations did not exist.
- The first WSL sanitizer behavior run preserved only `$HOME/.local/bin`: `tr`, `awk`, and `paste` had been resolved through the deliberately hostile test PATH. Absolute Linux utility paths fixed the root cause.
- Behavioral tests initially found no exported high-entropy callback generator, no executable local-import validator, and no branded User-Agent seam.
- Init-template, settings/updater locale, and TUI tip audits found `OpenCode`, `opencode.json`, and unsupported `$schema` copy.

## Wave 6 GREEN verification

```text
chelper$ npm test -- --run
31 pass, 0 fail
chelper$ npm run build
pass
chelper$ npx tsc --noEmit
pass

packages/opencode$ bun test test/share/quarantine.test.ts test/share/share-next.test.ts test/share/session-disabled.test.ts test/cli/import.test.ts test/oem/public-exits.test.ts test/cli/acp/initialize-auth.test.ts test/cli/help/help-snapshots.test.ts test/mcp/oauth-provider.test.ts
30 pass, 0 fail; 33 help snapshots
packages/core$ bun test test/database-migration.test.ts -t 'share revocation material'
1 pass, 0 fail
packages/core$ bun test test/plugin/skill.test.ts
1 pass, 0 fail
packages/app$ bun test src/public-exits.test.ts
4 pass, 0 fail
packages/tui$ bun test test/public-copy.test.ts
3 pass, 0 fail
packages/desktop$ bun test src/main/wsl/runtime-contract.test.ts
2 pass, 0 fail

packages/core|opencode|tui|app|desktop$ bun typecheck
pass in all five packages
packages/core$ bun run script/migration.ts --check
pass; no ungenerated migration

packages/app$ bun run build
pass
packages/desktop$ bun run build
pass
packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed: 0.0.0-ruying-code-oem-202607111734
```

Credential verification used the exact former value without printing it:

```text
Chelper tracked tree: clean
Chelper current dist: clean
Chelper fresh npm pack: clean
Identified stale archives: absent
```

Here, “tracked tree” means Chelper Git-tracked files at that revision. It was not a claim about ignored primary-worktree review scratch files.

No npm publish, production request, public share request, or other real network action was performed.

## Wave 6 commits

Primary:

- `7f5ed51f3` — `fix: harden final OEM boundaries`

Chelper:

- `e9c600c` — `fix(security): purge legacy credential artifacts`

## Mandatory external action and remaining concerns

- **An administrator must revoke/rotate the formerly exposed legacy credential in the external service.** Source redaction, artifact deletion, clean scans, and local commits cannot invalidate an already exposed credential. External rotation is not complete and is not claimed by this report.
- App/Desktop builds retain the repository's existing Vite dynamic-import, duplicate sourcemap, and chunk-size warnings; all builds exited successfully.
- The post-commit parallel build verification reproduced the known shared-artifact race: Desktop observed `ENOENT` while the simultaneous Opencode build replaced `packages/opencode/dist/node`. The required sequential Desktop rerun passed. This is recorded as a build-order constraint, not hidden as a parallel pass.
- Chelper's unrelated untracked `.serena/` directory remains preserved unchanged.

---

# Wave 7 Re-review Fixes

Date: 2026-07-12

## Wave 7 dispositions

- Branded the active Core/V2 `/init` template and added behavior-level assertions for both active init implementations.
- Replaced every remaining visible `OpenCode` and `opencode.json` locale value across all App/Desktop locales with Ruying Code and `ruying-code.json`; executable audits cover the full locale corpus.
- Canonicalized WSL npm and `ruying-code` paths with `/usr/bin/readlink -f --` immediately after `command -v` and before `/mnt/*` rejection. The Linux-only behavior test creates a symlink to `/mnt` and verifies canonical rejection; it is skipped on this macOS verification host and will execute on Linux where `/mnt` exists. The lexical PATH-preservation test remains cross-platform and passed locally.
- Rejected UNC/network-share import forms (`\\server`, `//server`, and `\\?\UNC`) before acquiring `FSUtil` or reading a file. URL/share transport remains disabled and no fetch path exists.
- Replaced Chelper's process-local-only publication transaction with an adjacent owner-token filesystem lock keyed by canonical auth target. The lock covers snapshot, auth publication, config publication, and rollback; it waits across processes, recovers dead owners, releases only its token, and leaves no lock or temporary file. A real two-process failure/success interleaving reproduces the stale rollback before the fix and verifies the successful process wins afterward.
- Extracted and exercised Chelper callback request handling: wrong paths return 404, successful browser output never contains the bearer, and only the exact unguessable path yields the token to the local process.
- Strengthened bounded tests with actual local HTTP User-Agent capture, exact ACP terminal command metadata, quarantine conflict/idempotence behavior, and validation-before-filesystem ordering.
- Deleted only `.superpowers/sdd/final-chelper-rereview-5.diff` and `final-chelper-rereview-6.diff`, the two ignored review artifacts whose exact credential matches were confirmed. Preserved `.serena/` and all unrelated files.

## Wave 7 RED evidence

- The Core command-plugin behavior test returned the upstream `OpenCode`/`opencode.json` init template.
- The all-locale audit found remaining visible upstream product/config values outside Wave 6's updater/settings subset.
- UNC behavior tests accepted all three network-share forms.
- WSL source/contract tests found no canonicalization between `command -v` and mounted-path rejection.
- Chelper callback behavior had no reusable parser boundary for exact-path and output assertions.
- After fixing the child-process harness itself, the real two-process test produced the valid pre-fix failure: process B completed successfully, then process A's failed transaction restored the initial auth bytes and erased B's `second-key`.

## Wave 7 GREEN verification

```text
chelper$ npm test -- --run
34 pass, 0 fail
chelper$ npm run build
pass
chelper$ npx tsc --noEmit
pass

packages/core$ bun test test/plugin/command.test.ts test/plugin/skill.test.ts
2 pass, 0 fail
packages/opencode$ bun test test/cli/import.test.ts test/plugin/ruying.test.ts test/cli/acp/initialize-auth.test.ts test/share/quarantine.test.ts test/oem/public-exits.test.ts
66 pass, 0 fail
packages/app$ bun test src/public-exits.test.ts
5 pass, 0 fail
packages/desktop$ bun test src/main/wsl/runtime-contract.test.ts
2 pass, 0 fail, 1 Linux-only symlink test skipped on macOS
packages/tui$ bun test test/public-copy.test.ts
3 pass, 0 fail

packages/core|opencode|app|desktop|tui$ bun typecheck
pass in all five packages

packages/app$ bun run build
pass
packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed: 0.0.0-ruying-code-oem-202607111803
packages/desktop$ bun run build
pass in the required sequential order
```

Exact-value credential verification did not print the credential:

```text
Chelper tracked source/current source: clean
Chelper current dist: clean
Chelper fresh npm pack: clean
Primary review scratch: clean
Confirmed credential-bearing ignored review diffs: absent
```

No npm publish, production request, public-share request, or other real network action was performed.

## Model-context disposition

The adjacent model-context architecture predates the OEM work and is intentionally not expanded in this wave. A bounded `origin/dev...HEAD` review found no OEM changes to `packages/core/src/session/runner/model.ts`, Core compaction context selection, or `packages/opencode/src/session/llm/native-request.ts`. The OEM diff in `provider.ts` changes branding headers and command copy only; the OEM Session changes add the Ruying authorization boundary, branding, and removal of public retry exits, with no new direct unbounded context-limit source. Therefore there is no confirmed OEM-introduced model-context regression to fix.

## Wave 7 commits

Primary:

- `70023358e` — `fix: close remaining OEM boundaries`

Chelper:

- `141dbee` — `fix(config): serialize cross-process publication`

## Mandatory external action and remaining concerns

- **An administrator must still revoke/rotate the formerly exposed credential in the external service.** Local redaction, artifact deletion, serialization, and clean scans cannot invalidate an already exposed credential; external rotation is not claimed complete.
- The WSL symlink-to-`/mnt` behavior test is present but skipped on this macOS host because `/mnt` is unavailable. Source assertions and the cross-platform lexical sanitizer test passed locally; the symlink behavior runs on Linux.
- App/Desktop builds retain their pre-existing Vite warnings. Desktop must remain sequential after the Opencode build because both use the shared Opencode dist directory.
- Chelper's unrelated untracked `.serena/` directory remains preserved unchanged.
