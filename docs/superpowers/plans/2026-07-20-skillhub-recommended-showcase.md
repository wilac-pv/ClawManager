# SkillHub Recommended Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate “推荐精选” from every slug returned by SkillHub's official `/api/v1/showcase/recommended` endpoint while preserving the last published recommendation set during upstream failures.

**Architecture:** Add a narrow SkillHub adapter that validates the official Showcase response and returns an unbounded slug set. Fetch that set independently from the full catalog, then apply it to materialized SkillHub details before the existing enterprise overlay and snapshot publication stages.

**Tech Stack:** TypeScript, Bun, Effect Schema, Bun test, versioned OSS catalog snapshots.

## Global Constraints

- Follow the repository dependency direction and existing TypeScript style in `AGENTS.md`.
- Do not change public Protocol, Server `HttpApi`, generated Client files, Schema, or database migrations.
- Keep full SkillHub catalog loading unchanged; the Showcase request must not trigger additional detail or package downloads.
- Use every slug returned by `/api/v1/showcase/recommended`; do not impose a Top 50 or other local limit.
- A failed Showcase request preserves previous `featured` values; a successful empty response clears SkillHub recommendations.
- Existing enterprise-index entries with `featured: true` remain eligible for “推荐精选”.
- Run tests and type checking from `packages/skill-market-server`, never from the repository root.

---

## File Structure

- Modify `packages/skill-market-server/src/skillhub.ts`: validate and load official recommended slugs.
- Modify `packages/skill-market-server/test/sources.test.ts`: cover the adapter path, complete 100-item result, validation, and redirect boundary.
- Modify `packages/skill-market-server/src/sync.ts`: fetch recommendations independently and apply success/fallback semantics.
- Modify `packages/skill-market-server/test/sync.test.ts`: cover slug/alias matching, clearing, failure preservation, and publication when only recommendations refresh.

### Task 1: Official Showcase Adapter

**Files:**

- Modify: `packages/skill-market-server/src/skillhub.ts`
- Test: `packages/skill-market-server/test/sources.test.ts`

**Interfaces:**

- Consumes: the existing `Fetcher` type and SkillHub HTTPS base URL.
- Produces:

```ts
export async function loadSkillHubRecommendations(
  fetcher: Fetcher,
  input: string,
): Promise<ReadonlySet<string>>
```

- [ ] **Step 1: Write the failing adapter tests**

Update the import in `test/sources.test.ts`:

```ts
import { loadSkillHub, loadSkillHubRecommendations } from "../src/skillhub"
```

Add tests inside `describe("catalog sources", ...)`:

```ts
test("loads every official SkillHub recommendation without a local limit", async () => {
  const slugs = Array.from({ length: 100 }, (_, index) => `recommended-${index + 1}`)
  const calls: string[] = []
  const recommendations = await loadSkillHubRecommendations(async (input) => {
    calls.push(requestUrl(input))
    return Response.json({
      section: "recommended",
      total: slugs.length,
      skills: slugs.map((slug) => ({ slug })),
    })
  }, "https://api.skillhub.cn")

  expect(calls).toEqual(["https://api.skillhub.cn/api/v1/showcase/recommended"])
  expect(Array.from(recommendations)).toEqual(slugs)
})

test("rejects malformed and cross-host recommendation responses", async () => {
  await expect(
    loadSkillHubRecommendations(
      async () => Response.json({ section: "recommended", total: 1, skills: [{}] }),
      "https://api.skillhub.cn",
    ),
  ).rejects.toThrow()

  await expect(
    loadSkillHubRecommendations(async () => {
      const response = Response.json({ section: "recommended", total: 1, skills: [{ slug: "safe" }] })
      Object.defineProperty(response, "url", { value: "https://evil.example.com/api/v1/showcase/recommended" })
      return response
    }, "https://api.skillhub.cn"),
  ).rejects.toThrow("redirected outside")
})
```

- [ ] **Step 2: Run the adapter tests and verify RED**

Run from `packages/skill-market-server`:

```bash
bun test test/sources.test.ts
```

Expected: TypeScript/test failure because `loadSkillHubRecommendations` is not exported.

- [ ] **Step 3: Implement the minimal Showcase loader**

Add the response schema near the existing SkillHub response schemas in `src/skillhub.ts`:

```ts
const ShowcaseResponse = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ slug: Schema.String })),
})
```

Add the public adapter before the existing `loadSkillHub` overloads:

```ts
export async function loadSkillHubRecommendations(fetcher: Fetcher, input: string) {
  const baseUrl = requireBaseUrl(input)
  const response = await fetchJson(
    fetcher,
    new URL("/api/v1/showcase/recommended", baseUrl),
    ShowcaseResponse,
    baseUrl.hostname,
  )
  return new Set(response.skills.map((skill) => skill.slug))
}
```

Do not add a local slice, limit, sort, detail lookup, or package download.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
bun test test/sources.test.ts
```

Expected: all `sources.test.ts` tests pass, including the new 100-item and rejection cases.

- [ ] **Step 5: Commit the adapter**

```bash
git add packages/skill-market-server/src/skillhub.ts packages/skill-market-server/test/sources.test.ts
git commit -m "feat(skill-market): load official recommendations"
```

### Task 2: Recommendation Application and Failure Fallback

**Files:**

- Modify: `packages/skill-market-server/src/sync.ts`
- Test: `packages/skill-market-server/test/sync.test.ts`

**Interfaces:**

- Consumes: `loadSkillHubRecommendations(...)`, current materialized SkillHub details, and the existing previous-detail map keyed by ID and aliases.
- Produces:

```ts
export function applySkillHubRecommendations(
  details: ReadonlyArray<SkillMarket.Detail>,
  recommendations: ReadonlySet<string> | undefined,
  previous: ReadonlyMap<string, SkillMarket.Detail>,
): SkillMarket.Detail[]
```

- [ ] **Step 1: Write failing pure behavior tests**

Add `applySkillHubRecommendations` to the existing import from `../src/sync` in `test/sync.test.ts`, then add:

```ts
test("applies official recommendations by id or alias and clears absent slugs", () => {
  const aliased = sampleDetail({ id: "manifest-name", aliases: ["showcase-slug"] })
  const removed = sampleDetail({ id: "removed", featured: true })
  const result = applySkillHubRecommendations(
    [aliased, removed],
    new Set(["showcase-slug"]),
    new Map([
      ["showcase-slug", aliased],
      ["removed", removed],
    ]),
  )

  expect(result.find((detail) => detail.id === "manifest-name")?.featured).toBe(true)
  expect(result.find((detail) => detail.id === "removed")?.featured).toBe(false)
})

test("preserves prior recommendations only when the Showcase request fails", () => {
  const previous = sampleDetail({ featured: true })
  const current = sampleDetail({ featured: false })

  expect(
    applySkillHubRecommendations([current], undefined, new Map([[previous.id, previous]]))[0]?.featured,
  ).toBe(true)
  expect(applySkillHubRecommendations([current], undefined, new Map())[0]?.featured).toBe(false)
  expect(applySkillHubRecommendations([previous], new Set(), new Map([[previous.id, previous]]))[0]?.featured).toBe(
    false,
  )
})
```

- [ ] **Step 2: Write the failing synchronization test**

Add a test showing that recommendations are an independent refresh source even when the full catalog and enterprise source fail:

```ts
test("publishes refreshed recommendations when catalog sources fall back to the prior snapshot", async () => {
  const objects = new Map<string, Uint8Array>()
  const store = memoryStore(objects)
  await publishSnapshot(store, { prefix: "skill-market" }, sampleSnapshot("prior"))
  await store.put(
    "skill-market/sync-state.json",
    JSON.stringify({
      lastSkillhubAt: "2026-07-15T00:00:00.000Z",
      enterpriseIndex: { schemaVersion: 1, updatedAt: "2026-07-15T00:00:00.000Z", skills: [] },
    }),
    "application/json",
    "no-store",
  )
  const result = await synchronize({
    config: loadConfig({
      SKILL_MARKET_ENTERPRISE_INDEX_URL: "https://oss.example.com/enterprise.json",
      SKILL_MARKET_OSS_ENDPOINT: "https://oss.example.com",
      SKILL_MARKET_PUBLIC_BASE_URL: "https://oss.example.com/skill-market/",
      SKILL_MARKET_OSS_PREFIX: "skill-market",
      SKILL_MARKET_ALLOWED_HOSTS: "api.skillhub.cn,oss.example.com",
    }),
    store,
    now: () => new Date("2026-07-15T00:20:00.000Z"),
    fetcher: async (input) => {
      const url = requestUrl(input)
      if (url.endsWith("/api/v1/showcase/recommended"))
        return Response.json({
          section: "recommended",
          total: 1,
          skills: [{ slug: "code-review" }],
        })
      return new Response(null, { status: 500 })
    },
  })

  expect(result.published).toBe(true)
  expect(result.snapshot.items.find((item) => item.id === "code-review")?.featured).toBe(true)
  expect(result.snapshot.sourceStatus.skillhub).toBe("stale")
})
```

- [ ] **Step 3: Run synchronization tests and verify RED**

Run from `packages/skill-market-server`:

```bash
bun test test/sync.test.ts
```

Expected: failure because `applySkillHubRecommendations` does not exist and `synchronize` still returns the unchanged previous snapshot when all catalog sources fail.

- [ ] **Step 4: Implement recommendation application**

Update the SkillHub import in `src/sync.ts`:

```ts
import { type SkillHubRecord, loadSkillHub, loadSkillHubRecommendations } from "./skillhub"
```

Add this named concept near the other synchronization helpers:

```ts
export function applySkillHubRecommendations(
  details: ReadonlyArray<SkillMarket.Detail>,
  recommendations: ReadonlySet<string> | undefined,
  previous: ReadonlyMap<string, SkillMarket.Detail>,
) {
  return details.map((detail) => {
    const ids = [detail.id, ...(detail.aliases ?? [])]
    const featured = recommendations
      ? ids.some((id) => recommendations.has(id))
      : ids.map((id) => previous.get(id)).find(Boolean)?.featured ?? false
    return detail.featured === featured ? detail : { ...detail, featured }
  })
}
```

This helper distinguishes failed requests (`undefined`) from a successful empty result (`new Set()`).

- [ ] **Step 5: Fetch recommendations independently and apply them before enterprise overlays**

Start the recommendation request after `previousSkillhub` is built and before awaiting the full catalog:

```ts
const recommendationsPromise = settled(
  loadSkillHubRecommendations(options.fetcher, options.config.skillhubBaseUrl),
)
```

After resolving the existing `skillhub` operation, await it:

```ts
const recommendations = await recommendationsPromise
if (!recommendations.ok)
  console.warn(
    JSON.stringify({
      skill_market_showcase_error: {
        message: recommendations.error instanceof Error ? recommendations.error.message : String(recommendations.error),
      },
    }),
  )
```

Replace the direct `skillhubDetails` assignment with a raw-detail selection followed by application:

```ts
const loadedSkillhubDetails = skillhub.ok
  ? skillhub.value.details
  : previous.ok
    ? sourceDetails(previous.value, "skillhub")
    : []
const skillhubDetails = applySkillHubRecommendations(
  loadedSkillhubDetails,
  recommendations.ok ? recommendations.value : undefined,
  previousSkillhub,
)
```

Change the existing no-source early return so a successful recommendation refresh can publish against the prior snapshot:

```ts
if (!skillhub.ok && !enterprise.ok && !community.ok && previous.ok && !recommendations.ok) {
  emitMetrics(performance.now() - started, previous.value, false, false, false)
  return { snapshot: previous.value, published: false }
}
```

Keep existing `sourceStatus` calculation and enterprise overlay behavior unchanged.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
bun test test/sources.test.ts test/sync.test.ts test/catalog.test.ts
```

Expected: all focused tests pass; the catalog test confirms enterprise `featured: true` remains supported.

- [ ] **Step 7: Run complete package verification**

Run from `packages/skill-market-server`:

```bash
bun test
bun typecheck
```

Expected: all package tests pass with zero failures and type checking exits 0.

Run from the repository root:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the planned source and test changes are uncommitted.

- [ ] **Step 8: Commit the synchronization behavior**

```bash
git add packages/skill-market-server/src/sync.ts packages/skill-market-server/test/sync.test.ts
git commit -m "feat(skill-market): sync official recommendations"
```

### Task 3: Final Regression and Deployment Handoff

**Files:**

- Verify: `packages/skill-market-server/src/skillhub.ts`
- Verify: `packages/skill-market-server/src/sync.ts`
- Verify: `packages/skill-market-server/test/sources.test.ts`
- Verify: `packages/skill-market-server/test/sync.test.ts`

**Interfaces:**

- Consumes: the two implementation commits from Tasks 1 and 2.
- Produces: a verified branch ready for release packaging; no production deployment is performed in this task.

- [ ] **Step 1: Review the complete feature diff**

Run from the repository root:

```bash
git diff 9753ea592..HEAD -- packages/skill-market-server docs/superpowers/plans/2026-07-20-skillhub-recommended-showcase.md
```

Expected: only the documented adapter, synchronization, tests, and design/plan changes.

- [ ] **Step 2: Re-run fresh verification**

Run from `packages/skill-market-server`:

```bash
bun test
bun typecheck
```

Expected: zero test failures and a typecheck exit code of 0.

- [ ] **Step 3: Confirm repository state**

Run from the repository root:

```bash
git status --short --branch
git log -n 4 --oneline
```

Expected: no uncommitted implementation changes. The branch contains the design, plan, adapter, and synchronization commits.

- [ ] **Step 4: Prepare deployment verification commands**

After a separately approved deployment, verify the production API with:

```bash
curl --fail --silent --show-error \
  "http://127.0.0.1:4210/v1/catalog/skills?page=1&limit=100&featured=true&sort=featured"
```

Expected: `total` is nonzero and every returned item has `featured: true`. Compare the matched SkillHub slug set to the current official Showcase response before declaring deployment complete.
