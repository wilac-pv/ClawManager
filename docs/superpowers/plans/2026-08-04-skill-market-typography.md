# Skill Market Typography Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved Chinese-first typography hierarchy consistently across every SkillHub page, component, form control, desktop viewport, and mobile viewport.

**Architecture:** Define one global system-sans stack and semantic typography tokens in `styles.css`, then remove component-local font overrides and incidental English eyebrow copy. Protect the result with string, computed-style, component, build, and Playwright page-sweep checks.

**Tech Stack:** SolidJS, CSS custom properties, Happy DOM, Playwright, Vite.

## Global Constraints

- Remove incidental English labels such as `Personal workspace` and `Skill package`.
- Keep the SkillHub brand and required technical names including API, ZIP, SHA-256, and SemVer.
- Use the approved system sans-serif stack for UI and a monospace stack only for code, commands, hashes, and machine identifiers.
- `button`, `input`, `select`, and `textarea` inherit the global font.
- Do not alter layout, color, data flow, permissions, or behavior except where text wrapping requires a local spacing correction.
- Verify every top-level page at desktop and mobile widths.

---

### Task 1: Establish semantic typography tokens and remove mixed-language eyebrow copy

**Files:**
- Modify: `packages/skill-market-web/src/styles.css`
- Modify: `packages/skill-market-web/src/submissions/form.tsx`
- Modify: `packages/skill-market-web/src/submissions/list.tsx`
- Modify: `packages/skill-market-web/src/space/layout.tsx`
- Modify: `packages/skill-market-web/src/admin/layout.tsx`
- Modify: `packages/skill-market-web/src/expert-packages/list.tsx`
- Modify: `packages/skill-market-web/src/expert-packages/detail.tsx`
- Test: `packages/skill-market-web/src/app.test.ts`
- Test: `packages/skill-market-web/src/space/layout.test.tsx`
- Test: `packages/skill-market-web/src/submissions/form.test.tsx`

**Interfaces:**
- Produces: `--font-ui`, `--font-mono`, and semantic size/line-height/weight tokens used by all later component work.

- [ ] **Step 1: Write failing copy and CSS contract tests**

```ts
expect(styles).toContain('--font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;')
expect(styles).toMatch(/button,\s*input,\s*select,\s*textarea[\s\S]*font: inherit/)
expect(renderedText).not.toContain("Personal workspace")
expect(renderedText).not.toContain("Skill package")
```

- [ ] **Step 2: Run tests and verify RED**

Run from `packages/skill-market-web`: `bun run test:unit && bun run test:browser`

Expected: missing tokens, missing inherited controls, and English labels fail assertions.

- [ ] **Step 3: Add exact root tokens and inheritance rules**

```css
:root {
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --text-page: 2rem;
  --text-section: 1.25rem;
  --text-card: 1.0625rem;
  --text-body: 0.875rem;
  --text-small: 0.8125rem;
  --leading-title: 1.25;
  --leading-body: 1.65;
  --weight-medium: 500;
  --weight-semibold: 650;
  --weight-bold: 700;
}
html, body { font-family: var(--font-ui); }
button, input, select, textarea { font: inherit; }
code, pre, kbd, samp, .machine-id, .hash { font-family: var(--font-mono); }
```

Replace English eyebrow copy with concise Chinese context labels; do not translate technical terms listed in Global Constraints.

- [ ] **Step 4: Verify and commit**

Run from `packages/skill-market-web`: `bun run test:unit && bun run test:browser && bun typecheck`

```bash
git add packages/skill-market-web/src/styles.css packages/skill-market-web/src/submissions/form.tsx packages/skill-market-web/src/submissions/list.tsx packages/skill-market-web/src/space/layout.tsx packages/skill-market-web/src/admin/layout.tsx packages/skill-market-web/src/expert-packages/list.tsx packages/skill-market-web/src/expert-packages/detail.tsx packages/skill-market-web/src/app.test.ts packages/skill-market-web/src/space/layout.test.tsx packages/skill-market-web/src/submissions/form.test.tsx
git commit -m "fix(skill-market): unify typography tokens"
```

### Task 2: Apply the hierarchy across catalog, personal, and administration components

**Files:**
- Modify: `packages/skill-market-web/src/styles.css`
- Modify: `packages/skill-market-web/src/shell.tsx`
- Modify: `packages/skill-market-web/src/favorites.tsx`
- Modify: `packages/skill-market-web/src/submissions/detail.tsx`
- Modify: `packages/skill-market-web/src/admin/queue.tsx`
- Modify: `packages/skill-market-web/src/admin/review.tsx`
- Modify: `packages/skill-market-web/src/admin/roles.tsx`
- Modify: `packages/skill-market-web/src/admin/audit.tsx`
- Modify: `packages/skill-market-web/src/admin/announcements.tsx`
- Modify: `packages/skill-market-web/src/admin/skillhub.tsx`
- Modify: `packages/skill-market-web/src/announcements/carousel.tsx`
- Modify: `packages/skill-market-web/src/announcements/detail.tsx`
- Modify: `packages/skill-market-web/src/announcements/history.tsx`
- Test: matching `*.test.tsx` files for each changed component family

**Interfaces:**
- Consumes: Task 1 tokens.
- Produces: one hierarchy for page titles, section titles, card titles, body, secondary text, labels, badges, and buttons.

- [ ] **Step 1: Add failing computed-class and visible-copy assertions**

Assert each top-level page uses the shared page-heading class, controls do not set local font families, machine IDs use `.machine-id`, and no incidental English eyebrow remains.

```tsx
expect(view.getByRole("heading", { level: 1 }).classList).toContain("type-page-title")
expect(view.getByText("req_ABC123").classList).toContain("machine-id")
expect(view.container.textContent).not.toMatch(/Personal workspace|Skill package|Admin console/)
```

- [ ] **Step 2: Run browser tests and verify RED**

Run from `packages/skill-market-web`: `bun run test:browser`

- [ ] **Step 3: Apply semantic classes and remove local overrides**

Map all headings and text to `.type-page-title`, `.type-section-title`, `.type-card-title`, `.type-body`, `.type-secondary`, `.type-label`, and `.type-badge`. Use CSS variables rather than repeating raw font sizes. Keep only `.machine-id`, `.hash`, `code`, `pre`, `kbd`, and `samp` on `--font-mono`.

- [ ] **Step 4: Verify and commit**

Run from `packages/skill-market-web`: `bun run test:browser && bun typecheck && bun run build`

```bash
git add packages/skill-market-web/src/styles.css packages/skill-market-web/src/shell.tsx packages/skill-market-web/src/favorites.tsx packages/skill-market-web/src/submissions/detail.tsx packages/skill-market-web/src/admin packages/skill-market-web/src/announcements packages/skill-market-web/src/*.test.tsx packages/skill-market-web/src/submissions/*.test.tsx packages/skill-market-web/src/admin/*.test.tsx
git commit -m "fix(skill-market): apply Chinese type hierarchy"
```

### Task 3: Add desktop/mobile visual sweep and release gate

**Files:**
- Modify: `packages/skill-market-web/e2e/fixtures/server.ts`
- Modify: `packages/skill-market-web/e2e/market.e2e.ts`
- Modify: `packages/skill-market-web/playwright.config.ts`
- Modify: `packages/skill-market-web/README.md`

**Interfaces:**
- Consumes: Tasks 1–2 typography implementation and the scoped-sharing/lifecycle pages.
- Produces: repeatable page sweep at desktop and mobile widths plus documented visual acceptance.

- [ ] **Step 1: Write failing page-sweep tests**

```ts
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  await page.setViewportSize(viewport)
  for (const path of ["/skills", "/personal", "/submissions", "/groups", "/favorites", "/trash", "/admin"]) {
    await page.goto(path)
    await expect(page.locator("h1")).toHaveCSS("font-family", /PingFang SC|Microsoft YaHei|Segoe UI/)
    await expect(page.locator("button").first()).toHaveCSS("font-family", /PingFang SC|Microsoft YaHei|Segoe UI/)
  }
}
```

- [ ] **Step 2: Run E2E and verify RED**

Run from `packages/skill-market-web`: `bun run test:e2e`

Expected: new group/trash fixtures or computed font assertions fail before the complete page sweep is wired.

- [ ] **Step 3: Complete fixtures, responsive corrections, and documentation**

Seed representative long Chinese titles, employee IDs, hashes, empty states, error states, and confirmation dialogs. Correct only wrapping, line-height, or spacing regressions caused by typography. Document the two required viewports and the page checklist in the Web README.

- [ ] **Step 4: Run all Web gates and commit**

Run from `packages/skill-market-web`: `bun test && bun typecheck && bun run build && bun run test:e2e`

Expected: all unit, browser, build, and Playwright checks pass at both viewports.

```bash
git add packages/skill-market-web/e2e packages/skill-market-web/playwright.config.ts packages/skill-market-web/README.md packages/skill-market-web/src/styles.css
git commit -m "test(skill-market): verify typography sweep"
```
