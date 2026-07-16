# Skill Market Base-Path Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every Skill Market navigation and SSO callback under `/ai-coding/ruying-code/skill-market/` when the Web app is deployed below an origin root.

**Architecture:** The browser continues to send only an allowlisted app-relative route such as `/submissions/new`. The server owns a separately validated `SKILL_MARKET_WEB_BASE_PATH`, combines it with `SKILL_MARKET_WEB_ORIGIN`, and uses the resulting trusted base URL for callback redirects and public detail URLs. Router-aware links replace raw root-relative anchors.

**Tech Stack:** TypeScript, Solid Router, Effect HttpApi, Bun test, Vite, Nginx.

## Global Constraints

- Preserve strict allowlisting of SSO `returnTo`; do not accept arbitrary absolute URLs or deployment prefixes from the browser.
- Keep `SKILL_MARKET_WEB_ORIGIN` origin-only for CORS and cookie security decisions.
- Normalize `SKILL_MARKET_WEB_BASE_PATH` to a leading and trailing slash; default to `/`.
- Run tests and type checks from `packages/skill-market-web` and `packages/skill-market-server`, never from repository root.
- Deploy Web and API releases atomically and keep prior release symlinks available for rollback.

---

### Task 1: Normalize Browser Return Paths and Links

**Files:**
- Modify: `packages/skill-market-web/src/session.test.tsx`
- Modify: `packages/skill-market-web/src/session.tsx`
- Modify: `packages/skill-market-web/src/app.tsx`
- Modify: `packages/skill-market-web/src/shell.tsx`

**Interfaces:**
- Consumes: Vite `import.meta.env.BASE_URL` with a trailing slash.
- Produces: `SkillMarketSessionProvider` prop `basePath?: string` and `safeReturnTo(value, basePath?)` returning only allowlisted app-relative routes.

- [ ] **Step 1: Write the failing sub-path login test**

Update the anonymous protected-route test to render `/ai-coding/ruying-code/skill-market/submissions/new` with base path `/ai-coding/ruying-code/skill-market/`, click SSO login, and expect:

```ts
expect(fixture.navigations).toEqual([
  "http://127.0.0.1:4210/v1/auth/login?returnTo=%2Fsubmissions%2Fnew",
])
```

- [ ] **Step 2: Run the browser unit test and verify RED**

Run: `bun test src/session.test.tsx`

Expected: FAIL because the current provider rejects the prefixed path and emits `returnTo=%2Fskills`.

- [ ] **Step 3: Implement base-path stripping and router-aware links**

Add `basePath?: string` to `SessionProviderProps`, call `safeReturnTo(returnTo, props.basePath)`, and strip only an exact trusted base prefix before applying the existing route allowlist. Pass `import.meta.env.BASE_URL` from `App`. Replace raw `<a href="/skills">` elements in the shell and guard with Solid Router `<A>`.

- [ ] **Step 4: Run Web tests and verify GREEN**

Run: `bun test src/session.test.tsx src/shell.test.tsx`

Expected: all tests pass.

### Task 2: Build a Trusted Server Web Base URL

**Files:**
- Modify: `packages/skill-market-server/test/sources.test.ts`
- Modify: `packages/skill-market-server/src/config.ts`
- Modify: `packages/skill-market-server/deploy/ruying-skill-market.env.example`

**Interfaces:**
- Consumes: `SKILL_MARKET_WEB_ORIGIN` and optional `SKILL_MARKET_WEB_BASE_PATH`.
- Produces: `config.webBasePath: string` and `config.webBaseUrl: string`.

- [ ] **Step 1: Write failing configuration tests**

Configure `SKILL_MARKET_WEB_BASE_PATH=/ai-coding/ruying-code/skill-market` and expect:

```ts
expect(config.webBasePath).toBe("/ai-coding/ruying-code/skill-market/")
expect(config.webBaseUrl).toBe("http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/")
```

Also assert that dot segments, query strings, fragments, backslashes, and non-absolute paths are rejected.

- [ ] **Step 2: Run the config test and verify RED**

Run: `bun test test/sources.test.ts`

Expected: FAIL because `webBasePath` and `webBaseUrl` do not exist.

- [ ] **Step 3: Implement minimal base-path validation**

Normalize safe path segments to one leading and trailing slash, reject unsafe syntax, and derive `webBaseUrl` with `new URL(webBasePath, webUrl).href`. Keep `webOrigin` unchanged.

- [ ] **Step 4: Run the config test and verify GREEN**

Run: `bun test test/sources.test.ts`

Expected: all tests pass.

### Task 3: Redirect SSO Callbacks Under the Base Path

**Files:**
- Modify: `packages/skill-market-server/test/control-http.test.ts`
- Modify: `packages/skill-market-server/src/http/auth.ts`
- Modify: `packages/skill-market-server/src/handlers.ts`
- Modify: `packages/skill-market-server/src/server.ts`

**Interfaces:**
- Consumes: `MarketHttpOptions.webBaseUrl` ending in `/` and allowlisted `result.returnTo` beginning with `/`.
- Produces: callback `Location` equal to `new URL(result.returnTo.slice(1), webBaseUrl).href`.

- [ ] **Step 1: Write the failing callback redirect test**

Set the HTTP fixture base URL to `http://127.0.0.1:4211/ai-coding/ruying-code/skill-market/`, complete a login for `/submissions`, and expect the callback `Location` to be:

```text
http://127.0.0.1:4211/ai-coding/ruying-code/skill-market/submissions
```

- [ ] **Step 2: Run the callback test and verify RED**

Run: `bun test test/control-http.test.ts`

Expected: FAIL because the current callback redirects to `http://127.0.0.1:4211/submissions`.

- [ ] **Step 3: Implement base-aware redirect wiring**

Add `webBaseUrl` to `MarketHttpOptions`, pass it from `server.ts`, use it in `createAuthHttp`, and pass it to publisher/community URL producers while retaining `webOrigin` for CORS.

- [ ] **Step 4: Run Server tests and verify GREEN**

Run: `bun test test/control-http.test.ts test/sources.test.ts`

Expected: all tests pass.

### Task 4: Verify, Deploy, and Reproduce the Original Flow

**Files:**
- Modify: `/etc/ruying-skill-market/market.env` on the deployment host.
- Create: immutable API and Web releases under `/srv/ruying-skill-market/releases/` and `/srv/ruying-skill-market/web/releases/`.

**Interfaces:**
- Consumes: `SKILL_MARKET_WEB_BASE_PATH=/ai-coding/ruying-code/skill-market/`.
- Produces: a live SSO attempt whose stored `return_to` is `/submissions/new` and callback `Location` remains under the configured base path.

- [ ] **Step 1: Run repository gates**

Run `bun run test:unit`, `bun test`, `bun typecheck`, and the production Web build from their package directories. Run `git diff --check`.

- [ ] **Step 2: Install the protected server configuration**

Back up `/etc/ruying-skill-market/market.env`, set `SKILL_MARKET_WEB_BASE_PATH=/ai-coding/ruying-code/skill-market/`, preserve owner `root:ruying-market` and mode `0640`, and never print other environment values.

- [ ] **Step 3: Deploy immutable API and Web releases**

Record previous symlinks, install the candidate releases, switch atomically, restart the API, and run health plus deployment smoke checks. Roll back both symlinks and configuration if a check fails.

- [ ] **Step 4: Verify the original browser flow**

Open the market, click `投稿 Skill`, click the guard SSO action, verify the new login attempt stores `/submissions/new`, then exercise a test callback with a non-sensitive fixture token or inspect the callback redirect test evidence. Confirm `/ai-coding/ruying-code/skill-market/submissions/new` renders and browser console errors are zero.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-07-16-skill-market-base-path-login.md packages/skill-market-web packages/skill-market-server
git commit -m "fix(skill-market): preserve web base path"
```
