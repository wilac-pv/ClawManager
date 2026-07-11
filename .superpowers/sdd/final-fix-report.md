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

# Wave 13 Re-review Fixes

Date: 2026-07-12

## Wave 13 corrections and dispositions

- `Brand.docsURL()` and `Brand.supportURL()` now share one admission boundary before UI or prompt use. An accepted value must parse as an absolute HTTPS URL, contain no username or password, and occupy at most 512 UTF-8 bytes. The original accepted string is preserved; invalid or oversized values are omitted. Changelog behavior is unchanged.
- Owner, WAL, and snapshot reads no longer rely on a pre-read size followed by `readFileSync` to EOF. Verified descriptors use one reader that allocates at most the configured maximum plus one byte and stops at that boundary. A post-open overflow is rejected. A file already oversized during legacy inspection retains Wave 12's bounded, metadata-only legacy recovery behavior.
- Transaction owner and WAL now persist exact `parents.auth/config.dev/ino` values from bigint filesystem metadata as canonical nonnegative decimal strings. Owner and WAL shapes require exact keys and exact identity equality. **Wave 14 correction:** Wave 13 incorrectly kept schema version 1 while making these parent fields required; Wave 14 introduces version 2 and explicit version-1 compatibility behavior.
- Auth/config parent anchors are opened and held before publishing the owner. Dead recovery validates the complete owner and WAL, opens current no-follow parent anchors, and compares both recorded identities before resource-temp cleanup, snapshot restore, or target publication. A same-path real directory replacement therefore fails closed with the canonical main retained.
- Production root selection is factored into the pure `resolveGlobalLockRootPath()` entry point used by the creating/validating resolver. Two real children with divergent `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME`, and no injected lock root, select the same OS-account-derived path. This is evidence for production path selection only; no live acquisition in the actual user directory is claimed.
- Chelper `docs/config-publication.md` documents the positional publication callback as a scheduling/failure hook that never owns resource I/O, the synchronous verified-open/read test hook and exception propagation, the 64 KiB owner, 48 MiB WAL, and 16 MiB decoded per-snapshot caps, and parent-identity recovery behavior.
- Corrected the recovery wording: approved targets are exact absolute fixed-canonical path strings, while replacement protection comes from separately persisted and revalidated parent filesystem identities. Path strings alone are not described as descriptor anchors.

## Wave 13 RED and diagnostic evidence

- Exact 513-byte, HTTP, credential-bearing, and malformed docs/support values were returned raw before the Brand validator. A 20,000-character HTTPS-prefixed value placed `PROMPT_INJECTION_DO_NOT_FOLLOW` directly in the model-visible system prompt.
- The production selector child exited with a missing-export error before `resolveGlobalLockRootPath()` existed.
- Deterministic verified-open callbacks showed owner and 16 MiB snapshot growth were not rejected because the callback/bounded reader did not exist. The WAL concurrent-growth case was added after the shared bounded reader and is recorded as GREEN coverage, not separately claimed as test-first RED evidence.
- Before durable parent identities, a killed child left owner/WAL records with no `parents` field. After renaming the original parent and creating a real replacement directory at the same pathname, recovery exited successfully and operated through the replacement path rather than failing closed.
- The first bounded-reader GREEN attempt rejected the snapshot overflow but not the owner overflow. `inspectLock` caught the distinct post-open owner overflow during malformed-owner retries and eventually classified the now-oversized record as legacy. The correction propagates only `BoundedReadOverflowError` while preserving pre-existing oversized legacy-owner recovery. No further production implementation attempt failed.
- The first full-suite run after parent identity had 83 passes and one fixture failure: a manually constructed durability owner omitted the new required parent metadata and therefore retired under a legacy identity. Adding the actual bigint parent identity to that fixture restored its intended generation-tombstone assertion; this was a fixture-schema update, not a production failure.

## Wave 13 GREEN verification

```text
packages/core$ bun test test/brand.test.ts
17 pass, 0 fail, 30 expects
packages/core$ bun typecheck
pass

packages/opencode$ bun test test/session/system.test.ts
14 pass, 0 fail, 46 expects
packages/opencode$ bun typecheck
pass
packages/opencode$ bun run build --single --skip-install
pass; smoke test 0.0.0-ruying-code-oem-202607112051

chelper$ npm test
5 files, 88 pass, 0 fail
  configurer: 77 pass, 0 fail
chelper$ npm run build
pass; tsup ESM 135.21 KiB

Primary and Chelper git diff checks
pass
```

The bounded-growth matrix starts owner, WAL, and snapshot files at exactly 64 KiB, 48 MiB, and 16 MiB respectively, grows each by one byte after verified open, and observes rejection before auth/config mutation. The parent codec matrix rejects leading-zero, signed, extra-field, and owner/WAL-mismatched identities. A real child killed at `auth-published`, followed by rename and a real replacement directory, exits recovery with status 1; the replacement directory listing and every victim byte remain identical, and the canonical transaction lock remains for inspection.

The production selector child test does not pass an injected root and invokes only the pure production selector, so it creates no user-home lock artifact. It deliberately does not prove real-user-root acquisition. Filesystem integration ran on macOS. Windows still has no POSIX UID-equivalent owner check through this Node surface; bigint `dev`/`ino`, directory type, symlink, and identity checks remain in the shared implementation, but no Windows OS execution is claimed.

Generic credential-pattern scans produced zero Chelper matches. Primary matches were limited to three pre-existing example/test fixture files (`github/README.md`, HTTP recorder redaction tests, and a Bedrock test access-key fixture); no Wave 13 changed file matched. No credential value was printed by the scan.

No npm publish, production request, public-share request, dependency installation, push, PR, or other real external network action was performed.

## Wave 13 commits

Primary:

- `445752f75` — `docs: design Wave 13 hardening`
- `82cee2b2f` — `docs: plan Wave 13 hardening`
- `5461b8b14` — `fix(core): bound branded support URLs`

Chelper:

- `edb3fa6` — `fix(config): bind recovery to parent identity`

Documentation:

- This report commit — `docs: record Wave 13 verification`

## Mandatory external action and remaining concerns

- **An administrator must still revoke/rotate the formerly exposed credential in the external service.** Local redaction, scans, bounded reads, parent identity, and commits cannot invalidate an already exposed credential; external rotation is not claimed complete.
- Auth/config files larger than 16 MiB cannot enter the recoverable publication protocol; owner metadata larger than 64 KiB and WAL larger than 48 MiB fail closed or enter the documented bounded legacy path. These are deliberate bounded-memory availability tradeoffs.
- A live or PID-reused owner still causes conservative waiting and can time out after 30 seconds. It is never evicted based on age or invalid target semantics.
- Node still has no portable `openat`/`renameat`. Held descriptors plus bigint identity revalidation detect pathname replacement but are not an atomic namespace-relative rename primitive. Windows directory fsync and power-loss behavior remain unverified.
- App build retains its pre-existing dynamic-import, duplicate sourcemap, and large-chunk warnings.
- Chelper's unrelated untracked `.serena/` directory remains preserved unchanged.

# Wave 14 Re-review Fixes

Date: 2026-07-12

## Wave 14 corrections and dispositions

- Brand URL admission now rejects raw `U+0000..U+0020`, `U+007F`, `U+2028`, and `U+2029` code points before WHATWG parsing. This blocks silently stripped LF, CR, and tab plus prompt-breaking line and paragraph separators. Percent-encoded representations such as `%0A` remain accepted. HTTPS-only, no-credentials, 512 UTF-8 byte, and exact original-string requirements remain unchanged.
- Current Chelper coordinator and transaction owner records are version 2. Current transaction WAL is also version 2. Owner parsing is an exact discriminated union for v1/v2 coordinator and transaction shapes; extra, missing, or cross-version fields are invalid.
- Historical v1 transaction targets are retained without semantic validation until immutable PID fencing. A live v1 PID blocks contenders even when targets are relative or otherwise invalid, and the owner is never classified or retired as legacy.
- A dead v1 transaction has no trustworthy parent identity. It now throws `v1 事务需要手动恢复` before WAL read, resource-temp cleanup, anchor creation, restore, journal removal, or retirement. Canonical main, owner, WAL, auth, and config remain for administrator inspection. A dead v1 coordinator contains no resource transaction and remains safely retireable.
- Automatic WAL recovery is restricted to strict v2 owner/WAL records with exact matching targets and parent identities. Current crafted fixtures explicitly use v2; the live/dead compatibility fixtures and coordinator fixture explicitly preserve v1.
- Chelper operator documentation now names v2 as current and documents live-v1 fencing, dead-v1 manual recovery, artifact retention, and the safe dead-v1 coordinator exception.

## Wave 14 RED and diagnostic evidence

- Raw LF, CR, tab, `U+2028`, and `U+2029` values were returned by both Brand accessors. Each unique marker entered the model-visible docs and support prompt text. Percent-encoded `%0A` already remained accepted and unchanged.
- A real process supplied the PID for an exact v1 targets-only transaction owner with invalid relative targets. The contender settled within the 500 ms observation window (`settled=true`), proving the record had been classified and retired as legacy instead of fencing the live PID.
- A dead v1 owner plus v1 WAL failed with `无法恢复缺少 owner 的事务日志` rather than recognizing a transaction requiring manual recovery. Resources happened to remain unchanged in that path, but the immutable v1 identity and required operational disposition were lost.
- A newly generated prepared owner and WAL both reported version 1 after Wave 13, proving the required-parent schema had changed without a version bump.
- The first written-plan commit accidentally materialized escaped code points as control bytes in Markdown and Git recorded the file as binary. Two preserved follow-up documentation commits normalized the file and rewrote the regex instruction in plain code-point language. No source or production behavior was affected. No production implementation attempt failed.

## Wave 14 GREEN verification

```text
packages/core$ bun test test/brand.test.ts
23 pass, 0 fail, 42 expects
packages/core$ bun typecheck
pass

packages/opencode$ bun test test/session/system.test.ts
19 pass, 0 fail, 56 expects
packages/opencode$ bun typecheck
pass
packages/opencode$ bun run build --single --skip-install
pass; smoke test 0.0.0-ruying-code-oem-202607112231

chelper$ npm test
5 files, 91 pass, 0 fail
  configurer: 80 pass, 0 fail
chelper$ npm run build
pass; tsup ESM 135.90 KiB
```

The real live-v1 test observes the contender blocked with the canonical main present and no dead tombstone. The dead-v1 test asserts the manual-recovery message, byte-identical auth/config, and retained owner/WAL. Dedicated coverage confirms a dead targets-free v1 coordinator retires and publication proceeds. The existing v2 replacement-directory crash, bounded-growth, durable-state, temp cleanup, recovery contender, and symlink matrices remain GREEN.

Filesystem integration ran on macOS. Windows still has no POSIX UID-equivalent owner check through this Node surface, and no Windows OS execution or power-loss durability is claimed. Production resolver evidence remains limited to artifact-free OS-account path selection; it does not claim live acquisition at the actual user root.

Changed-file credential-pattern scans returned zero matching files in both Primary and Chelper. Both repository diff checks passed. Chelper's unrelated `.serena/` remained excluded and untouched.

No npm publish, production request, public-share request, dependency installation, push, PR, or other real external network action was performed.

## Wave 14 commits

Primary:

- `d1e9d9122` — `docs: design Wave 14 compatibility`
- `f58506a3e` — `docs: plan Wave 14 compatibility`
- `bd63db262` — `docs: normalize Wave 14 plan text`
- `d482f13cc` — `docs: clarify Wave 14 raw URL gate`
- `58913e0fb` — `fix(core): reject raw branded URL controls`

Chelper:

- `23fc5ee` — `fix(config): version durable transactions`

Documentation:

- This report commit — `docs: record Wave 14 verification`

## Mandatory external action and remaining concerns

- **An administrator must still revoke/rotate the formerly exposed credential in the external service.** Local redaction, scans, URL admission, schema versioning, and commits cannot invalidate an already exposed credential; external rotation is not claimed complete.
- A dead v1 transaction deliberately requires administrator inspection and manual recovery because it lacks trustworthy parent identity. Automatic retirement or restore would be unsafe.
- Auth/config files larger than 16 MiB cannot enter the recoverable publication protocol; owner metadata larger than 64 KiB and WAL larger than 48 MiB retain the documented bounded behavior.
- A live or PID-reused owner remains safety-first and can cause a conservative 30-second timeout.
- Node still has no portable `openat`/`renameat`; held descriptors and identity revalidation are defense-in-depth rather than an atomic namespace-relative rename primitive. Windows directory fsync and power-loss behavior remain unverified.
- App build retains its pre-existing dynamic-import, duplicate sourcemap, and large-chunk warnings.
- Chelper's unrelated untracked `.serena/` directory remains preserved unchanged.


---

# Wave 7 Re-review Fixes

Date: 2026-07-12

## Wave 7 dispositions

- Branded the active Core/V2 `/init` template and added behavior-level assertions for both active init implementations.
- Replaced every remaining visible `OpenCode` and `opencode.json` locale value across all App locales with Ruying Code and `ruying-code.json`; the App executable audit covers that locale corpus. Wave 7 did not audit the separate dormant Desktop renderer dictionaries; Wave 8 closes that gap.
- Canonicalized WSL npm and `ruying-code` paths with `/usr/bin/readlink -f --` immediately after `command -v` and before `/mnt/*` rejection. The Linux-only behavior test creates a symlink to `/mnt` and verifies canonical rejection; it is skipped on this macOS verification host and will execute on Linux where `/mnt` exists. The lexical PATH-preservation test remains cross-platform and passed locally.
- Rejected UNC/network-share import forms (`\\server`, `//server`, and `\\?\UNC`) before acquiring `FSUtil` or reading a file. URL/share transport remains disabled and no fetch path exists.
- Replaced Chelper's process-local-only publication transaction with an adjacent owner-token filesystem lock keyed by canonical auth target. The lock covers snapshot, auth publication, config publication, and rollback; it waits across processes, recovers dead owners, releases only its token, and leaves no lock or temporary file. A real two-process failure/success interleaving reproduces the stale rollback before the fix and verifies the successful process wins afterward.
- Extracted and exercised Chelper callback request handling: wrong paths return 404, successful browser output never contains the bearer, and only the exact unguessable path yields the token to the local process.
- Strengthened bounded tests with actual local HTTP User-Agent capture, exact ACP terminal command metadata, quarantine conflict/idempotence behavior, and validation-before-filesystem ordering.
- Deleted only `.superpowers/sdd/final-chelper-rereview-5.diff` and `final-chelper-rereview-6.diff`, the two ignored review artifacts whose exact credential matches were confirmed. Preserved `.serena/` and all unrelated files.

## Wave 7 RED evidence

- The Core command-plugin behavior test returned the upstream `OpenCode`/`opencode.json` init template.
- The App all-locale audit found remaining visible upstream product/config values outside Wave 6's updater/settings subset.
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

# Wave 8 Re-review Fixes

Date: 2026-07-12

## Wave 8 dispositions

- Wave 8 replaced Chelper's single-file compare/unlink lock with generation directories and an atomic `transition/` claimant before renaming a generation to quarantine. Re-review found this was still incomplete: the lease was unfenced against a paused owner, transition-claim crash recovery was not complete, and deleting quarantine allowed a sufficiently delayed observer to target a successor. Wave 9 removes this design rather than extending it.
- Wave 8 added a 500 ms heartbeat under a 2 second lease. This handled the tested routine waits and partial-owner case, but it did not make PID reuse or a live process pause safe: a process paused beyond the lease could resume after another owner. Wave 9 replaces elapsed-time eviction with conservative PID liveness and fenced publication.
- Canonical auth targets now resolve their deepest existing ancestor with `realpathSync` and append missing components. Existing target symlinks and missing targets under symlinked parent aliases therefore share one transaction identity and adjacent filesystem lock.
- Moved the real process worker from `src/tools` to `test/fixtures`; production packaging no longer carries a test entrypoint.
- Narrowed local-import rejection to true backslash UNC and extended UNC device forms. `\\server`, `\\?\UNC`, and `\\.\UNC` are rejected before `FSUtil.Service`; extended local drives such as `\\?\C:\...`, POSIX `//tmp/...`, `C://...`, ordinary drive paths, and relative paths remain accepted unchanged. Remote URI schemes remain disabled.
- Branded all 16 dormant Desktop renderer locale dictionaries from visible OpenCode/`opencode` command copy to Ruying Code/`ruying-code`. A whole-dictionary contract keeps internal compatibility/storage identifiers out of scope while enforcing every visible dictionary value.
- Corrected the Wave 7 report: that wave's whole-locale audit covered App dictionaries, not the separate dormant Desktop renderer dictionaries.

## Wave 8 RED and diagnostic evidence

- The real two-breaker Chelper test started two child processes against one incomplete expired generation. The old single-file protocol returned child exits `[1, 1]` instead of `[0, 0]` because it could not interpret or transition a lock directory.
- The canonical-target unit test found no `canonicalAuthTarget` function; the old `resolve()` result preserved a missing target's symlink-parent spelling.
- The first transition-directory implementation timed out once. Creating `transition/` updated the incomplete generation directory mtime, causing the breaker to invalidate its own stale observation forever. The corrected implementation carries the pre-claim missing-owner/expired-generation observation across the transition claim, while revalidating any owner that appears. No other implementation attempts failed.
- The real symlink-parent two-process regression already passed before the canonicalization change because both adjacent lock spellings resolve to the same physical directory on this POSIX host. It is retained as strengthened cross-process coverage and is not misreported as a pre-fix failure.
- Import behavior rejected valid `//tmp/session.json` under the broad double-slash rule; the same old branches also rejected `C://...` as a URI scheme and `\\?\C:\...` as a broad double-backslash path.
- The Desktop dictionary audit failed first on `da.ts`, showing visible OpenCode and `opencode` CLI copy in the dormant dictionary corpus.

## Wave 8 GREEN verification

```text
chelper$ npm test
5 files, 38 pass, 0 fail
chelper$ npm run build
pass
chelper$ npx tsc --noEmit
pass

packages/opencode$ bun test test/cli/import.test.ts
2 pass, 0 fail, 18 expects
packages/opencode$ bun typecheck
pass

packages/desktop$ bun test src/renderer/i18n/brand-contract.test.ts src/main/wsl/runtime-contract.test.ts
3 pass, 0 fail, 1 Linux-only WSL symlink test skipped on macOS, 56 expects
packages/desktop$ bun typecheck
pass

packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed: 0.0.0-ruying-code-oem-202607111827
packages/desktop$ bun run build
pass in the required sequential order
```

The Chelper configurer suite includes real child-process coverage for two simultaneous stale breakers with an exclusive critical-section sentinel, a held transaction longer than the lease to prove heartbeat renewal, a current/reused PID with an expired lease, fresh partial-owner recovery within the acquisition budget, and missing targets through real and symlinked parents. The two-breaker protocol test uses Windows-supported Node filesystem operations and is not platform-gated, but this verification ran on macOS; no Windows execution is claimed. The symlink-parent tests are explicitly POSIX-gated.

Exact-value credential verification did not print the credential:

```text
Chelper tracked and full local tree excluding preserved .serena/node_modules: clean
Chelper current dist and fresh npm pack: clean
Primary tracked and full local tree excluding node_modules: clean
Desktop dormant renderer dictionary brand scan: clean
Primary and Chelper git diff checks: clean
```

No npm publish, production request, public-share request, package installation, or other real network action was performed.

## Wave 8 commits

Primary:

- `58a329418` — `fix: close Wave 8 OEM boundaries`

Chelper:

- `938f6b9` — `fix(config): make lock takeover ownership-safe`

## Mandatory external action and remaining concerns

- **An administrator must still revoke/rotate the formerly exposed credential in the external service.** Local redaction, clean scans, lock hardening, and commits cannot invalidate an already exposed credential; external rotation is not claimed complete.
- App/Desktop builds retain their pre-existing Vite dynamic-import, eval, sourcemap, and chunk-size warnings. Desktop was built only after the Opencode build completed because both use the shared Opencode dist directory.
- The Linux-only WSL symlink-to-`/mnt` test remains skipped on this macOS host. Wave 8's Chelper symlink-parent tests did execute on macOS; Windows execution was not available and is not claimed.
- Chelper's unrelated untracked `.serena/` directory remains preserved unchanged.

# Wave 9 Re-review Fixes

Date: 2026-07-12

## Wave 9 dispositions

- Inspected Chelper's direct/transitive dependencies, installed modules, and local npm cache before designing another lock. No `proper-lockfile`, `lockfile`, `fs-ext`, or equivalent cross-platform primitive is available. Node 18 has no cross-platform advisory filesystem lock. Primary Core's internal `Flock` also uses an unfenced heartbeat/stale-breaker design, so it was not copied into Chelper.
- Removed Chelper's elapsed-time lease, heartbeat, transition directory, and deletable quarantine. The short commit mutex is now claimed by fully writing `{pid, token}` in a unique candidate directory and atomically renaming that complete candidate to the canonical lock name.
- A currently existing PID is always treated as live, regardless of age. A PID-reuse collision therefore causes a conservative timeout instead of unsafe eviction. A clearly absent PID's complete canonical generation is atomically renamed to a deterministic, non-empty path keyed by the observed owner token. That dead-generation tombstone is deliberately permanent: every delayed observer of the same generation collides with the same occupied destination and cannot rename a successor. This leaves at most one small tombstone per real canonical-owner crash; normal releases leave no mutex artifact.
- Dead unique candidates are safe to remove because they were never canonical. A real child killed after publishing a complete candidate is cleaned by its successor without creating a dead-generation tombstone.
- The mutex covers only canonical auth snapshot/publication plus its adjacent ownership marker, or rollback compare-and-restore. The possibly paused config callback runs outside it. Each auth publication writes a unique transaction token, canonical target, and SHA-256 fingerprint to the marker. A failed obsolete transaction restores only when all three still match under the short mutex, so a successor is distinguished even when it writes identical auth bytes. **Wave 10 correction:** this fenced failed rollback, but it was not a complete auth/config transaction: two successful publishers could finish config out of order, and a crash between auth and config had no durable recovery record.
- Canonical target identity is re-established before the initial commit boundary. Snapshot, auth mutation, fingerprinting, marker publication, comparison, and rollback all use the fixed canonical target, never the mutable symlink alias. A symlink retarget sends the successor to its new target while the obsolete transaction can only restore its owned original target.
- Added a platform-aware network-path classifier. Backslash UNC remains rejected on every platform. Windows classification also rejects `//server`, `//?/UNC`, and `//./UNC`; non-Windows classification preserves POSIX double-slash roots such as `//tmp`. Extended local drives remain accepted. The command still validates before acquiring `FSUtil.Service`.

## Wave 9 RED and diagnostic evidence

- Dependency/cache inspection found no established cross-platform file-lock package. The adjacent Primary Core lock was rejected because its heartbeat/stale deletion is also unfenced for this resource protocol.
- The identical-byte successor test observed `successorProgressed=false`: Wave 8 held its lease lock across the paused config callback, so B could not commit until obsolete A resumed.
- The candidate-crash test reached the config callback (`ready`) rather than the required complete-candidate boundary (`candidate`), proving Wave 8 had no candidate publication phase.
- Two delayed dead-owner observers plus a held successor could not observe a stable successor canonical owner under the Wave 8 transition design, and no deterministic token tombstone existed.
- The source audit found the Wave 8 lease, heartbeat, transition, and quarantine machinery still present.
- The symlink-retarget behavior already passed under Wave 8's tested POSIX spelling, so it is retained as stronger fixed-canonical coverage and is not misreported as a pre-fix failure.
- The first symlink test run had a test-harness-only missing `unlinkSync` import. It was corrected before the valid behavior run and is not counted as product RED. No production implementation attempt failed.
- The import platform matrix found no exported platform classifier; the Wave 8 runtime rule on this macOS host accepted Windows forward-slash UNC spellings.

## Wave 9 GREEN verification

```text
chelper$ npm test
5 files, 40 pass, 0 fail
chelper$ npm run build
pass
chelper$ npx tsc --noEmit
pass

packages/opencode$ bun test test/cli/import.test.ts
2 pass, 0 fail, 26 expects
packages/opencode$ bun typecheck
pass

packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed: 0.0.0-ruying-code-oem-202607111853
packages/desktop$ bun run build
pass in the required sequential order
```

The Chelper suite uses real child processes for an identical-byte successor that commits while obsolete A is paused; a killed complete candidate followed by successful cleanup; two delayed observers of one dead token; a successor holding the canonical mutex longer than the former lease; one deterministic non-empty tombstone; normal release without a mutex artifact; and auth-symlink retargeting between publication and rollback. These filesystem tests ran on macOS. They use Node APIs intended to be cross-platform, but no Windows filesystem execution is claimed.

The import classifier's Windows matrix is pure and executed on macOS by passing `win32` explicitly. It proves the classification logic but is not a Windows OS integration run.

Exact-value credential verification did not print the credential:

```text
Chelper tracked and full local tree excluding preserved .serena/node_modules: clean
Chelper current dist and fresh npm pack: clean
Primary tracked and full local tree excluding node_modules: clean
Primary and Chelper git diff checks: clean
```

No npm publish, production request, public-share request, dependency installation, or other real external network action was performed.

## Wave 9 commits

Primary:

- `4adf9c06f` — `fix(opencode): classify platform UNC paths`

Chelper:

- `2939c3c` — `fix(config): fence cross-process rollback`

## Mandatory external action and remaining concerns

- **An administrator must still revoke/rotate the formerly exposed credential in the external service.** Local redaction, clean scans, fenced rollback, and commits cannot invalidate an already exposed credential; external rotation is not claimed complete.
- A real dead canonical mutex generation leaves one permanent small non-empty tombstone by design. This bounded disk cost is the fencing mechanism that prevents arbitrarily delayed observers from renaming a successor. PID reuse is handled conservatively by timing out while that PID exists.
- App/Desktop builds retain their pre-existing Vite dynamic-import, eval, sourcemap, and chunk-size warnings. Desktop was built only after the Opencode build completed because both use the shared Opencode dist directory.
- Chelper's unrelated untracked `.serena/` directory remains preserved unchanged.

# Wave 10 Re-review Fixes

Date: 2026-07-12

## Wave 10 correction and dispositions

- Corrected the Wave 9 conclusion: its short mutex and ownership marker prevented an obsolete failed transaction from rolling auth back over a successor, but the config callback deliberately ran outside the mutex. A paused successful A could therefore overwrite successful B's newer config after B completed. Wave 9 also had no write-ahead record from which a successor could recover a process killed between auth and config publication.
- Replaced that protocol with a no-lease transaction generation held through durable auth and config publication. A separate short lifecycle coordinator serializes inspection, recovery, claim, and release of the main generation. Complete candidates are fsynced before their atomic rename; current PIDs are never evicted based on elapsed time, and a possible PID-reuse collision times out conservatively.
- Added a versioned transaction journal in the main generation with `prepared`, `auth-published`, `config-published`, and `committed` states. Every update uses a mode-`0600` temporary file, file fsync, atomic rename, and parent-directory fsync. Recovery keeps a committed pair and otherwise restores config before auth from validated base64 snapshots, then removes the journal before publishing a metadata-only dead-generation tombstone.
- Recovery and successor installation occur while the lifecycle coordinator is held and while the original main generation remains canonical. Killing a real recovery holder cannot expose a half-recovered generation to another contender: the next contender recovers the coordinator, re-enters recovery idempotently, and only then installs its transaction.
- Journal validation binds the recorded owner to the fixed canonical auth/config targets and rejects unknown versions, states, target mismatches, relative config targets, or malformed snapshots. Invalid journals fail closed without changing either resource or replacing the canonical main generation.
- All canonical target snapshots and restores use no-follow inspection and reject symlinks and non-regular files. The config callback receives the fixed canonical config target, so alias retargeting cannot redirect a transaction or its recovery. The removed Wave 9 marker is cleaned by unlinking only its directory entry; a marker symlink's victim is never overwritten.
- Legacy empty or malformed main/coordinator generations receive bounded rereads at 25, 50, and 100 ms before deterministic legacy recovery. Dead main/coordinator generations become permanent non-empty tombstones; abandoned candidates and release artifacts are removed only when their ownership and artifact class are proven.
- Updated UNC classification to normalize slash direction only for classification. Windows now rejects mixed spellings such as `//server\\share`, `//?/UNC\\server`, and `//./UNC\\server`; mixed extended local-drive spellings remain accepted. Non-Windows still preserves POSIX `//tmp`, rejects backslash/mixed extended UNC, and accepts extended local drives.

## Wave 10 RED and diagnostic evidence

- In the real two-success interleaving, successful B progressed while A was paused, proving the Wave 9 short mutex did not order the config publication; after A resumed it could overwrite B's newer config.
- A child killed at the intended prepare boundary reported only the config callback's `ready` phase under Wave 9, proving there was no durable `prepared` boundary or journal.
- A legacy empty generation was replaced in about 35 ms, before the required bounded malformed-owner rereads.
- A deliberately invalid journal was accepted instead of failing closed.
- A Wave 9 marker symlink allowed its external victim to be overwritten.
- The import classifier accepted mixed `//?/UNC\\server` on the Windows classification path.
- One Wave 10 committed-boundary test initially waited for file existence, which was already true from an earlier journal state. The harness was corrected to wait for the exact committed content before the valid child-kill run. This was a test synchronization correction, not a production implementation failure. No production implementation attempt failed.

## Wave 10 GREEN verification

```text
chelper$ npm test
5 files, 51 pass, 0 fail
  configurer: 40 pass, 0 fail
chelper$ npm run build
pass
chelper$ npx tsc --noEmit
pass
chelper$ git diff --check
pass

packages/opencode$ bun test test/cli/import.test.ts
2 pass, 0 fail, 32 expects
packages/opencode$ bun typecheck
pass

packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed: 0.0.0-ruying-code-oem-202607111920
packages/desktop$ bun run build
pass in the required sequential order; pre-existing Vite warnings remain
```

The Chelper suite uses real child processes for two successful publishers with A paused through B's commit; kills after `prepared`, `auth-published`, `config-published`, and `committed`; and a killed recovery holder followed by two contenders. It observes the recovered auth/config pair before the successor publishes, verifies the successor ordering, proves idempotent recovery, and scans permanent tombstones for secret bytes. It also covers legacy empty/malformed main and coordinator generations, candidate/release cleanup, invalid-journal fail-closed behavior, marker-symlink victim safety, alias retargeting, and dangling aliases.

These filesystem tests ran on macOS. The pure import matrix passes `win32` explicitly and covers mixed-separator classification, but it is not a Windows OS integration run. No Windows filesystem execution is claimed.

Exact-value credential verification did not print the credential:

```text
Chelper tracked and full local tree excluding preserved .serena/node_modules: clean
Chelper current dist and fresh npm pack: clean
Primary tracked and full local tree excluding node_modules: clean
Primary and Chelper git diff checks: clean
```

No npm publish, production request, public-share request, dependency installation, push, PR, or other real external network action was performed.

## Wave 10 commits

Primary:

- `42d693c09` — `fix(opencode): reject mixed UNC paths`

Chelper:

- `d8f9dc2` — `fix(config): make publication crash recoverable`

Documentation:

- This report commit — `docs: record Wave 10 verification`

## Mandatory external action and remaining concerns

- **An administrator must still revoke/rotate the formerly exposed credential in the external service.** Local redaction, exact-value scans, WAL recovery, and commits cannot invalidate an already exposed credential; external rotation is not claimed complete.
- A journal temporarily contains recoverable auth/config snapshots and therefore can contain credentials. It is confined to the mode-`0700` transaction directory, written mode `0600`, and removed before a recovered generation becomes a permanent tombstone. Permanent tombstones contain metadata only. Invalid externally supplied journals deliberately remain canonical and fail closed, so an administrator must inspect/remove such an artifact rather than automatic recovery copying or deleting unknown content.
- Each genuinely dead canonical generation leaves one deterministic, permanent, small non-empty tombstone. This is the no-lease fencing cost that prevents delayed observers from acting on a successor. Current PIDs, including possible PID reuse, are never time-broken and may cause a conservative timeout.
- App/Desktop builds retain their pre-existing Vite dynamic-import, eval, sourcemap, and chunk-size warnings. Desktop was built only after the Opencode build completed because both use the shared Opencode dist directory.
- Chelper's unrelated untracked `.serena/` directory remains preserved unchanged.

# Wave 11 Re-review Fixes

Date: 2026-07-12

## Wave 11 corrections and dispositions

- Corrected the Wave 10 conflict-domain claim. Its no-lease main transaction was keyed by canonical auth target, so different auth files that published one shared config could overlap. Wave 11 uses one per-user global Chelper configuration transaction root, coordinator, main generation, and process-local queue. Any auth/config pair is serialized against every other pair.
- Corrected the Wave 10 anchoring claim. Fixed canonical path strings plus `lstat` did not make pathname reads/writes descriptor-anchored, and the injected config callback still owned canonical config I/O. Wave 11 makes the callback a scheduling/failure hook only. Production bytes use internal no-follow operations that compare pre-open `lstat`, opened-descriptor `fstat`, and post-open `lstat`; held parent-directory descriptors/fingerprints are rechecked before temp creation and before and after namespace changes.
- The global root is created mode `0700`, canonicalized, fsynced where supported, and rejected if it is a symlink or non-directory. Owner and journal files are mode `0600`. Complete owner metadata has exact version/PID/token/generation/target keys, and approved targets come from trusted fixed-canonical owner construction rather than the journal alone.
- Strict recovery validates the whole bounded WAL before either restore: exact keys, version/state, matching owner token/generation/targets, approved absolute canonical targets, allowed snapshot kinds, canonical base64, integer mode `0..0777`, a 16 MiB decoded snapshot bound, and a 48 MiB journal bound. Invalid owner/WAL state fails explicitly with the canonical main retained and both resources untouched.
- A real child killed after fsyncing a journal temp but before its rename is recovered by removing recognized temp artifacts before retirement. Non-committed valid recovery still restores config before auth; committed recovery keeps both.
- Corrected the Wave 10 tombstone claim. Renaming the original generation could retain unknown malformed or temporary bytes. Wave 11 first creates and fsyncs a fresh deterministic metadata-only tombstone, validates any existing tombstone, then—only while the global coordinator is held for main retirement—renames the old generation to a release artifact, fsyncs, deletes it, and fsyncs again. Permanent tombstones contain only `tombstone.json`.
- Candidate directory, candidate parent, acquire rename, journal rename, tombstone rename, retirement rename/cleanup, and normal release rename/cleanup transitions fsync their directories where Node supports it. Windows directory fsync remains an explicit no-op.
- PID reuse remains safety-first. No portable reliable process-start identity was available in the supported Node-only surface, so an existing PID is never time-broken. A reused PID can conservatively make the transaction unavailable until timeout rather than risk evicting a live owner.
- Windows import classification is allowlist-based for namespace paths. Ordinary consistent drive paths, consistent extended drive paths, and valid consistent `Volume{GUID}` paths are accepted. UNC, device, named pipe, `GLOBALROOT`, redirector, malformed volume, doubled separators, and mixed-leading/body separator paths are rejected before `FSUtil.Service`. Non-Windows POSIX `//tmp` remains local; backslash Windows namespace paths remain rejected.

## Wave 11 RED and diagnostic evidence

- In a real same-config/different-auth interleaving, B reached its config callback while A remained paused (`secondBlocked=false`), proving Wave 10's auth-derived lock did not cover shared config resources.
- In a real parent-swap test, the fixed config parent was renamed and replaced with a victim symlink during the callback window. Wave 10-style pathname publication overwrote the victim from `owner:victim` to `owner:new`.
- The Windows matrix showed `\\.\C:` device namespace was classified local.
- Wave 10's earlier invalid-journal diagnostic accepted malformed recovery state. Wave 11 adds twelve crafted owner/WAL cases covering extra fields, owner token/generation/target mismatches, noncanonical base64, fractional/out-of-range mode, invalid snapshot kind/shape, and size bounds. These table cases were added after the strict codec slice and therefore are recorded as GREEN coverage, not individually claimed as test-first RED evidence.
- The first Wave 11 full-suite migration run found six tests still constructing or scanning old auth-derived lock paths. After moving those fixtures to the global root, one auth-alias test timed out because its Wave 10 ordering waited for B before releasing A; the new global lock correctly blocked B. The test now proves B is blocked, releases A, then awaits both. These were test-contract migrations, not production implementation failures.
- Two old Windows expectations accepted mixed extended-drive spellings on nonmatching platforms. They were updated to the approved Wave 11 allowlist before the valid GREEN run. No production implementation attempt failed.

## Wave 11 GREEN verification

```text
chelper$ npm test
5 files, 69 pass, 0 fail
  configurer: 58 pass, 0 fail
chelper$ npm run build
pass
chelper$ npx tsc --noEmit
pass
chelper$ git diff --check
pass

packages/opencode$ bun test test/cli/import.test.ts
2 pass, 0 fail, 50 expects
packages/opencode$ bun typecheck
pass

packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed: 0.0.0-ruying-code-oem-202607111957
packages/desktop$ bun run build
pass in the required sequential order; pre-existing Vite warnings remain
```

Real child coverage includes same-config/different-auth serialization, all four durable journal states, a kill after journal-temp fsync, a killed recovery holder with two contenders, complete-candidate death, and fixed-canonical alias behavior. POSIX tests prove parent-swap and target-symlink swaps fail closed without mutating victims. Namespace hooks observe every required durability transition, and fresh tombstones are asserted to contain only metadata.

These filesystem tests ran on macOS. `O_NOFOLLOW` and directory fsync were exercised there. Node 18 has no portable `openat`/`renameat`; parent-descriptor identity checks detect tested swaps and narrow the pathname race, but this report does not claim an absolute directory anchor against a malicious same-user process changing a namespace between verification and the pathname operation. Windows directory fsync is not available through this portable Node implementation, so no Windows power-loss durability claim is made. The Windows classifier matrix is pure logic executed on macOS, not a Windows OS integration run.

Exact-value credential verification did not print the credential:

```text
Chelper tracked and full local tree excluding preserved .serena/node_modules: clean
Chelper current dist and fresh npm pack: clean
Primary tracked and full local tree excluding node_modules: clean
Primary and Chelper git diff checks: clean
```

No npm publish, production request, public-share request, dependency installation, push, PR, or other real external network action was performed.

## Wave 11 commits

Primary:

- `ef5b6d716` — `docs: design Wave 11 hardening`
- `526c2d4e4` — `fix(opencode): restrict Windows import paths`

Chelper:

- `04c1581` — `fix(config): harden global transactions`

Documentation:

- This report commit — `docs: record Wave 11 verification`

## Mandatory external action and remaining concerns

- **An administrator must still revoke/rotate the formerly exposed credential in the external service.** Local redaction, exact-value scans, global serialization, WAL validation, and commits cannot invalidate an already exposed credential; external rotation is not claimed complete.
- One global per-user transaction deliberately trades unrelated config-publication concurrency for a simple complete conflict domain. A live or PID-reused owner can cause a conservative 30-second timeout; it is never evicted based on age.
- A valid in-progress journal temporarily contains recoverable auth/config snapshots and can contain credentials. It is confined to mode-`0700` transaction storage in mode-`0600` files and removed before retirement. Invalid state stays canonical and fail-closed for administrator inspection. Permanent tombstones are fresh metadata only.
- Parent descriptor/fingerprint verification is defense-in-depth, not a portable substitute for `renameat`. Windows directory fsync/power-loss behavior and Windows filesystem execution remain unverified limitations.
- App/Desktop builds retain their pre-existing Vite dynamic-import, eval, sourcemap, and chunk-size warnings. Desktop was built only after the Opencode build completed because both use the shared Opencode dist directory.
- Chelper's unrelated untracked `.serena/` directory remains preserved unchanged.

# Wave 12 Re-review Fixes

Date: 2026-07-12

## Wave 12 corrections and dispositions

- Corrected the Wave 11 global-root claim. `homedir()` can follow mutable process environment on supported platforms, so two processes sharing resources could select different locks. Production now resolves the stable account home through `os.userInfo()`, never `HOME`, `USERPROFILE`, XDG, or the resource pair. Lookup failure is fail-closed. The mode-`0700` root must be a real directory and, where UIDs exist, owned by the effective UID. The explicit root override is an internal test hook only.
- Every auth/config publication temporary name now contains the already-durable WAL generation and token: `.<base>.ruying-txn.<generation>.<token>.<uuid>.tmp`. Coordinated dead recovery validates the entire owner/WAL first, then inspects only the two approved parents and deletes only regular files matching that exact generation/token/UUID form. Wrong generation, wrong token, partial suffix, symlink, and directory entries are never followed or removed.
- Resource-temp cleanup runs before and after recovery restore. Real children are stopped after auth-temp and config-temp fsync but before rename, then killed. Successor recovery removes the exact secret-bearing temp, restores the correct pair, preserves unrelated neighbor artifacts, and leaves zero resource-directory matches for the injected secret.
- Split immutable owner identity/PID parsing from target semantics. A structurally complete live owner remains owned even when its targets are malformed, unresolvable, or retargeted, so PID liveness fences it before semantic checks. Only dead recovery validates target shape and fixed-canonical meaning. A live parent-swap contender stays waiting without a tombstone; after the owner dies, recovery fails explicitly and retains the canonical main.
- Bounded legacy inspection no longer reads an arbitrary owner file. Files through 64 KiB use verified no-follow reads; oversized metadata contributes size and filesystem identity without reading its body. Empty, malformed, and 1 MiB owner cases retain the 25/50/100 ms bounded reread contract.
- Renamed the positional publication seam type and parameter to exported `ConfigPublicationHook` and `beforeConfigPublication`. Its call position and arguments remain compatible, but the name now states that it schedules or injects failure; internal verified code owns resource I/O.
- Transaction release now sits inside an outer `finally`, with config-anchor and auth-anchor closes nested in another `finally`. Both descriptors close even if release or the first close throws.
- Corrected Wave 11's Windows separator policy. Unsafe UNC/device/named-pipe/`GLOBALROOT`/redirector/invalid extended namespaces remain rejected. Ordinary drive-local paths allow Windows' normal separator normalization, including `C:\\dir/file` and `C://dir`. Extended drive and Volume GUID namespace spellings remain allowlisted only with a consistent namespace separator. Validation still precedes `FSUtil.Service`.
- The 16 MiB decoded per-snapshot and 48 MiB journal caps from Wave 11 remain unchanged and are now called out explicitly as availability limits for unusually large auth/config files.

## Wave 12 RED and diagnostic evidence

- Two real children used the same canonical auth/config and the same intended test lock root but divergent `HOME`, `USERPROFILE`, and XDG values. Wave 11 ignored the override and B reached its callback while A was paused (`blocked=false`).
- The production `resolveGlobalLockRoot` entry point did not exist, so the OS-user/environment-independence test failed before implementation.
- The real resource-temp crash mode timed out waiting for its fsync boundary because Wave 11 had no `onResourceTemp` boundary and its temp names did not contain WAL identity.
- The Windows matrix rejected `C://sessions/session.json`; ordinary drive normalization was too strict.
- A 500 ms live-parent observation initially passed under Wave 11. It was expanded to 1.2 seconds to cover all malformed-owner rereads and retirement work. Temporarily reintroducing Wave 11's combined target validation still did not produce unsafe retirement under the existing deterministic-tombstone guard, so this is retained as GREEN structural/liveness coverage and is not claimed as a product RED.
- The first GREEN fixture run omitted the new internal root argument for default workers. Four waits timed out and the children created a test transaction under the actual OS-account root. The directory contained only artifacts timestamped from that run; those test artifacts were removed immediately and every worker now receives an isolated temp root. This was a test-harness wiring error, not a production implementation failure. No production implementation attempt failed.

## Wave 12 GREEN verification

```text
chelper$ npm test
5 files, 78 pass, 0 fail
  configurer: 67 pass, 0 fail
chelper$ npm run build
pass
chelper$ npx tsc --noEmit
pass
chelper$ git diff --check
pass

packages/opencode$ bun test test/cli/import.test.ts
2 pass, 0 fail, 50 expects
packages/opencode$ bun typecheck
pass

packages/opencode$ bun run build --single --skip-install
pass; Smoke test passed: 0.0.0-ruying-code-oem-202607112023
packages/desktop$ bun run build
pass in the required sequential order; pre-existing Vite warnings remain
```

The real-process matrix covers divergent environments with shared resources, a live owner whose approved parent is swapped, auth and config resource-temp death after fsync, exact dead-generation cleanup, and the earlier journal/recovery boundaries. Exact-prefix symlink and directory artifacts fail closed with the main retained and no victim mutation. Unit coverage proves environment changes do not affect the production resolver, OS-user lookup failure rejects, and a foreign expected UID rejects on UID platforms.

These filesystem tests ran on macOS. The production root uses the OS account home, mode and UID checks there. Windows has no UID check in Node and the existing directory-fsync/power-loss limitation remains. Windows path results are pure classifier tests executed on macOS, not Windows OS integration.

Exact-value credential verification did not print the credential:

```text
Chelper tracked and full local tree excluding preserved .serena/node_modules: clean
Chelper current dist and fresh npm pack: clean
Primary tracked and full local tree excluding node_modules: clean
Primary and Chelper git diff checks: clean
```

No npm publish, production request, public-share request, dependency installation, push, PR, or other real external network action was performed.

## Wave 12 commits

Primary:

- `b49b135d3` — `docs: design Wave 12 recovery`
- `948197128` — `fix(opencode): normalize local drive imports`

Chelper:

- `2544209` — `fix(config): bind recovery artifacts`

Documentation:

- This report commit — `docs: record Wave 12 verification`

## Mandatory external action and remaining concerns

- **An administrator must still revoke/rotate the formerly exposed credential in the external service.** Local redaction, exact scans, WAL-bound temps, and commits cannot invalidate an already exposed credential; external rotation is not claimed complete.
- Auth/config files larger than 16 MiB cannot enter this recoverable publication protocol, and a journal larger than 48 MiB fails closed. This is a deliberate bounded-memory availability tradeoff.
- The production root trusts the OS account lookup. Failure, symlink/non-directory roots, and foreign UID ownership fail closed. Windows exposes no equivalent UID check through this Node surface.
- A live or PID-reused owner still causes conservative waiting and can time out after 30 seconds. It is never evicted based on age or invalid target semantics.
- Exact dead-generation cleanup deliberately leaves wrong-generation/token/partial artifacts for administrator inspection. An exact-prefix symlink or directory blocks recovery rather than being removed.
- Node still has no portable `openat`/`renameat`; parent descriptor checks are not an absolute namespace anchor. Windows directory fsync and power-loss behavior remain unverified.
- App/Desktop builds retain their pre-existing Vite dynamic-import, eval, sourcemap, and chunk-size warnings. Desktop was built only after the Opencode build completed.
- Chelper's unrelated untracked `.serena/` directory remains preserved unchanged.
