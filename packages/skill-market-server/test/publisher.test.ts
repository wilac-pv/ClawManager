import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../src/database"
import { mergeCatalog } from "../src/catalog"
import { loadCatalogIndex, loadCurrentSnapshot, publishSnapshot, type PrivateObjectStore } from "../src/oss"
import { createPublisher } from "../src/publisher"
import { createSkillHubImportStore } from "../src/skillhub-import-store"
import { validateSubmissionArchive } from "../src/submission-archive"
import { sampleDetail, sampleSnapshot } from "./fixture"
import { makeStoredZip } from "./zip"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("community publisher", () => {
  test("patches completed TRACE evaluations without decoding the full SkillHub mirror", async () => {
    const fixture = await publisherFixture()
    const evaluatedA = sampleDetail({ id: "trace-a", aliases: ["trace-a"], score: 100_000 })
    const evaluatedB = sampleDetail({ id: "trace-b", aliases: ["trace-b"], score: 100_000 })
    const unrelatedSkillHub = sampleDetail({ id: "skillhub-unchanged", aliases: ["old-alias"], featured: true })
    const community = sampleDetail({ id: "community-unchanged", source: "community", aliases: ["community-alias"], featured: true })
    const enterprise = sampleDetail({ id: "enterprise-unchanged", source: "enterprise", aliases: ["enterprise-alias"], featured: true })
    const snapshot = mergeCatalog(
      [evaluatedA, evaluatedB, unrelatedSkillHub, community, enterprise],
      { schemaVersion: 1, updatedAt: "2026-07-22T00:00:00.000Z", skills: [] },
    )
    await publishSnapshot(fixture.store, { prefix: "skill-market" }, snapshot)
    const completed = [evaluatedA, evaluatedB].map((detail, index) => {
      const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(detail)).digest("hex")
      return {
        slug: detail.id,
        summary: snapshot.items.find((summary) => summary.id === detail.id)!,
        detailKey: `details/${detailSha256}.json`,
        detailSha256,
        evaluation: {
          trust: 5,
          reliability: 4,
          adaptability: 4.3,
          convention: 4.325,
          effectiveness: 4.625,
          score: 4.45,
          checkedAt: fixture.clock.value + index,
        },
      }
    })
    const base = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    const replaced: string[][] = []
    const imports = {
      ...base,
      mirroredEntries() {
        throw new Error("full mirror decode is forbidden for TRACE delta publication")
      },
      completedEvaluations() {
        return completed
      },
      replaceCompletedEvaluationDetails(entries: Parameters<typeof base.replaceCompletedEvaluationDetails>[0]) {
        replaced.push(entries.map((entry) => entry.slug))
        return entries.map((entry) => entry.slug)
      },
    }

    await createPublisher(publisherOptions(fixture)).publishCompletedSkillHubEvaluations(imports, "worker-trace", 100)

    const published = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    for (const id of ["skillhub-unchanged", "community-unchanged", "enterprise-unchanged"]) {
      expect(published.items.find((summary) => summary.id === id)).toEqual(snapshot.items.find((summary) => summary.id === id))
      expect(published.details.get(`${id === "community-unchanged" ? "community" : id === "enterprise-unchanged" ? "enterprise" : "skillhub"}:${id}`)).toEqual(
        snapshot.details.get(`${id === "community-unchanged" ? "community" : id === "enterprise-unchanged" ? "enterprise" : "skillhub"}:${id}`),
      )
    }
    for (const id of ["trace-a", "trace-b"]) {
      expect(published.items.find((summary) => summary.id === id)).toMatchObject({ score: 0, evaluationScore: 4.45, traceEvaluation: evaluationValues() })
      expect(published.details.get(`skillhub:${id}`)).toMatchObject({ score: 0, evaluationScore: 4.45, traceEvaluation: evaluationValues() })
    }
    expect(replaced).toEqual([["trace-a", "trace-b"]])
    fixture.database.close()
  })

  test("does not publish a TRACE result whose checked time changes while waiting for the catalog lease", async () => {
    const fixture = await publisherFixture()
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    const detail = { ...snapshot.details.get("skillhub:code-review")!, id: "stale-checked", aliases: ["stale-checked"] }
    const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(detail)).digest("hex")
    fixture.objects.set(`skill-market/details/${detailSha256}.json`, bytes(JSON.stringify(detail)))
    const base = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    const first = {
      slug: "stale-checked",
      summary: { ...snapshot.items[0]!, id: "stale-checked", aliases: ["stale-checked"] },
      detailKey: `details/${detailSha256}.json`,
      detailSha256,
      evaluation: { ...evaluationValues(), score: 4.45, checkedAt: fixture.clock.value },
    }
    let calls = 0
    const replaced: string[][] = []
    const imports = {
      ...base,
      completedEvaluations() {
        calls += 1
        return calls === 1 ? [first] : [{ ...first, evaluation: { ...first.evaluation, checkedAt: fixture.clock.value + 1 } }]
      },
      replaceCompletedEvaluationDetails(entries: Parameters<typeof base.replaceCompletedEvaluationDetails>[0]) {
        replaced.push(entries.map((entry) => entry.slug))
        return entries.map((entry) => entry.slug)
      },
    }

    await createPublisher(publisherOptions(fixture)).publishCompletedSkillHubEvaluations(imports, "worker-trace", 100)

    expect((await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })).revision).toBe(snapshot.revision)
    expect(replaced).toEqual([])
    fixture.database.close()
  })

  test("does not publish a TRACE result whose previous detail hash changes while waiting for the catalog lease", async () => {
    const fixture = await publisherFixture()
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    const summary = snapshot.items.find((item) => item.source === "skillhub")!
    const detail = snapshot.details.get(`skillhub:${summary.id}`)!
    const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(detail)).digest("hex")
    const base = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    const first = {
      slug: summary.id,
      summary,
      detailKey: `details/${detailSha256}.json`,
      detailSha256,
      evaluation: { ...evaluationValues(), score: 4.45, checkedAt: fixture.clock.value },
    }
    let calls = 0
    const replaced: string[][] = []
    const imports = {
      ...base,
      completedEvaluations() {
        calls += 1
        return calls === 1 ? [first] : [{ ...first, detailSha256: "f".repeat(64) }]
      },
      replaceCompletedEvaluationDetails(entries: Parameters<typeof base.replaceCompletedEvaluationDetails>[0]) {
        replaced.push(entries.map((entry) => entry.slug))
        return entries.map((entry) => entry.slug)
      },
    }

    await createPublisher(publisherOptions(fixture)).publishCompletedSkillHubEvaluations(imports, "worker-trace", 100)

    expect((await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })).revision).toBe(snapshot.revision)
    expect(replaced).toEqual([])
    fixture.database.close()
  })

  test("retires a TRACE lease when an immutable catalog write fails before a target exists", async () => {
    const fixture = await publisherFixture()
    fixture.database.connection.run("DELETE FROM publish_jobs")
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    const summary = snapshot.items.find((item) => item.source === "skillhub")!
    const original = snapshot.details.get(`skillhub:${summary.id}`)!
    const unscored = original
    const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(unscored)).digest("hex")
    fixture.objects.set(`skill-market/details/${detailSha256}.json`, bytes(JSON.stringify(unscored)))
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    imports.seedLegacy([{
      slug: summary.id,
      summary,
      detailKey: `details/${detailSha256}.json`,
      detailSha256,
    }])
    fixture.database.connection.run(
      `UPDATE skillhub_import_items
       SET evaluation_state = 'completed', evaluation_score = 4.45, evaluation_trust = 5,
           evaluation_reliability = 4, evaluation_adaptability = 4.3, evaluation_convention = 4.325,
           evaluation_effectiveness = 4.625, evaluation_checked_at = ?
       WHERE slug = ?`,
      [fixture.clock.value, summary.id],
    )
    fixture.failures.put = /indexes\/.*\/catalog\.json$/

    const publisher = createPublisher(publisherOptions(fixture))
    const controller = new AbortController()
    expect(
      await rejected(publisher.publishCompletedSkillHubEvaluations(imports, "worker-trace", 100, controller.signal)),
    ).toBeInstanceOf(Error)
    expect(controller.signal.aborted).toBe(false)
    expect(
      fixture.database.connection
        .query<{ readonly count: number }, []>("SELECT count(*) AS count FROM publish_jobs WHERE kind = 'catalog_rebuild' AND status = 'pending'")
        .get()!.count,
    ).toBe(0)
    expect(
      fixture.database.connection
        .query<{ readonly count: number }, []>("SELECT count(*) AS count FROM publish_jobs WHERE kind = 'catalog_rebuild' AND status = 'failed'")
        .get()!.count,
    ).toBe(1)
    expect(await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })).toEqual(snapshot)
    expect(
      fixture.database.connection
        .query<{ readonly detail_sha256: string; readonly record_json: string | null }, [string]>(
          "SELECT detail_sha256, record_json FROM skillhub_import_items WHERE slug = ?",
        )
        .get(summary.id),
    ).toEqual({ detail_sha256: detailSha256, record_json: null })
    expect(imports.completedEvaluations(1).map((evaluation) => evaluation.slug)).toEqual([summary.id])

    fixture.failures.put = undefined
    await publisher.publishCompletedSkillHubEvaluations(imports, "worker-trace", 100, controller.signal)
    const published = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    expect(published.details.get(`skillhub:${summary.id}`)?.evaluationScore).toBe(4.45)
    expect(imports.completedEvaluations(1)).toEqual([])
    fixture.database.close()
  })

  test("cancels a TRACE pointer write without moving the pointer or materializing its evaluation", async () => {
    const fixture = await publisherFixture()
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    const summary = snapshot.items.find((item) => item.source === "skillhub")!
    const detail = snapshot.details.get(`skillhub:${summary.id}`)!
    const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(detail)).digest("hex")
    fixture.objects.set(`skill-market/details/${detailSha256}.json`, bytes(JSON.stringify(detail)))
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    imports.seedLegacy([{
      slug: summary.id,
      summary,
      detailKey: `details/${detailSha256}.json`,
      detailSha256,
    }])
    fixture.database.connection.run(
      `UPDATE skillhub_import_items
       SET evaluation_state = 'completed', evaluation_score = 4.45, evaluation_trust = 5,
           evaluation_reliability = 4, evaluation_adaptability = 4.3, evaluation_convention = 4.325,
           evaluation_effectiveness = 4.625, evaluation_checked_at = ?
       WHERE slug = ?`,
      [fixture.clock.value, summary.id],
    )
    let pointerStarted = false
    const controller = new AbortController()
    const publisher = createPublisher({
      ...publisherOptions(fixture),
      store: {
        ...fixture.store,
        async put(key, body, contentType, cacheControl, metadata, request) {
          if (!key.endsWith("/current.json"))
            return fixture.store.put(key, body, contentType, cacheControl, metadata, request)
          pointerStarted = true
          await new Promise<void>((_, reject) => request?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
        },
      },
    })
    const publication = publisher.publishCompletedSkillHubEvaluations(imports, "worker-trace", 100, controller.signal)

    await waitFor(() => pointerStarted)
    controller.abort()

    expect(await rejected(publication)).toBeInstanceOf(Error)
    expect(await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })).toEqual(snapshot)
    expect(imports.completedEvaluations(1).map((evaluation) => evaluation.slug)).toEqual([summary.id])
    expect(
      fixture.database.connection
        .query<{ readonly count: number }, []>("SELECT count(*) AS count FROM publish_jobs WHERE kind = 'catalog_rebuild' AND status = 'running'")
        .get()!.count,
    ).toBe(1)
    fixture.clock.value += 30_001
    expect(await publisher.recover()).toBe(1)
    expect(
      fixture.database.connection
        .query<{ readonly count: number }, []>("SELECT count(*) AS count FROM publish_jobs WHERE kind = 'catalog_rebuild' AND status = 'pending'")
        .get()!.count,
    ).toBe(1)
    fixture.database.close()
  })

  test("rematerializes legacy evaluated details with a public zero ranking score", async () => {
    const fixture = await publisherFixture()
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    const summary = snapshot.items.find((item) => item.source === "skillhub")!
    const raw = { ...snapshot.details.get(`skillhub:${summary.id}`)!, id: "legacy-score", aliases: ["legacy-score"], score: 100000 }
    const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(raw)).digest("hex")
    fixture.objects.set(`skill-market/details/${detailSha256}.json`, bytes(JSON.stringify(raw)))
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    imports.seedLegacy([{
      slug: "legacy-score",
      summary: { ...summary, id: "legacy-score", aliases: ["legacy-score"], score: 100000 },
      detailKey: `details/${detailSha256}.json`,
      detailSha256,
    }])
    fixture.database.connection.run(
      `UPDATE skillhub_import_items
       SET evaluation_state = 'completed', evaluation_score = 4.45, evaluation_trust = 5,
           evaluation_reliability = 4, evaluation_adaptability = 4.3, evaluation_convention = 4.325,
           evaluation_effectiveness = 4.625, evaluation_checked_at = ?
       WHERE slug = 'legacy-score'`,
      [fixture.clock.value],
    )

    await createPublisher(publisherOptions(fixture)).publishMirroredSkillHub(imports, "worker-trace")

    const published = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    expect(published.details.get("skillhub:legacy-score")?.score).toBe(0)
    expect(published.items.find((item) => item.id === "legacy-score")?.score).toBe(0)
    fixture.database.close()
  })

  test("publishes a completed TRACE evaluation without changing immutable SkillHub package metadata", async () => {
    const fixture = await publisherFixture()
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    const summary = snapshot.items.find((item) => item.source === "skillhub")!
    const original = snapshot.details.get(`skillhub:${summary.id}`)!
    const unscored = { ...original, id: "trace-score", aliases: ["trace-score"] }
    const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(unscored)).digest("hex")
    const ref = { key: `details/${detailSha256}.json`, sha256: detailSha256 }
    fixture.objects.set(`skill-market/${ref.key}`, bytes(JSON.stringify(unscored)))
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    imports.seedLegacy([{ slug: "trace-score", summary: { ...summary, id: "trace-score", aliases: ["trace-score"] }, detailKey: ref.key, detailSha256: ref.sha256 }])
    fixture.database.connection.run(
      `UPDATE skillhub_import_items
       SET evaluation_state = 'completed', evaluation_score = 4.45, evaluation_trust = 5,
           evaluation_reliability = 4, evaluation_adaptability = 4.3, evaluation_convention = 4.325,
           evaluation_effectiveness = 4.625, evaluation_checked_at = ?, summary_json = ?
       WHERE slug = 'trace-score'`,
      [fixture.clock.value, JSON.stringify({ ...summary, id: "trace-score", aliases: ["trace-score"], evaluationScore: 4.45, traceEvaluation: {
        trust: 5,
        reliability: 4,
        adaptability: 4.3,
        convention: 4.325,
        effectiveness: 4.625,
        evaluatedAt: new Date(fixture.clock.value).toISOString(),
      } })],
    )

    await createPublisher(publisherOptions(fixture)).publishMirroredSkillHub(imports, "worker-trace")

    const published = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    const detail = published.details.get("skillhub:trace-score")!
    expect(detail).toMatchObject({
      evaluationScore: 4.45,
      traceEvaluation: { trust: 5, reliability: 4, adaptability: 4.3, convention: 4.325, effectiveness: 4.625 },
      package: snapshot.details.get(`skillhub:${summary.id}`)!.package,
      aliases: ["trace-score"],
      featured: summary.featured,
      source: "skillhub",
    })
    expect(published.items.find((item) => item.id === "trace-score")).toMatchObject({
      evaluationScore: 4.45,
      traceEvaluation: { trust: 5, reliability: 4, adaptability: 4.3, convention: 4.325, effectiveness: 4.625 },
      source: "skillhub",
    })
    const updated = fixture.database.connection
      .query<{ readonly detail_key: string; readonly detail_sha256: string }, [string]>("SELECT detail_key, detail_sha256 FROM skillhub_import_items WHERE slug = ?")
      .get("trace-score")!
    expect(updated).not.toEqual({ detail_key: ref.key, detail_sha256: ref.sha256 })
    fixture.database.close()
  })

  test("fences a stale evaluated detail before it can move the catalog pointer", async () => {
    const fixture = await publisherFixture()
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    const summary = snapshot.items.find((item) => item.source === "skillhub")!
    const original = snapshot.details.get(`skillhub:${summary.id}`)!
    const staleDetail = { ...original, id: "fenced-score", aliases: ["fenced-score"] }
    const staleSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(staleDetail)).digest("hex")
    const currentDetail = { ...staleDetail, description: "newer mirror detail" }
    const currentSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(currentDetail)).digest("hex")
    fixture.objects.set(`skill-market/details/${staleSha256}.json`, bytes(JSON.stringify(staleDetail)))
    fixture.objects.set(`skill-market/details/${currentSha256}.json`, bytes(JSON.stringify(currentDetail)))
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    imports.seedLegacy([{
      slug: "fenced-score",
      summary: { ...summary, id: "fenced-score", aliases: ["fenced-score"] },
      detailKey: `details/${staleSha256}.json`,
      detailSha256: staleSha256,
    }])
    fixture.database.connection.run(
      `UPDATE skillhub_import_items
       SET evaluation_state = 'completed', evaluation_score = 4.45, evaluation_trust = 5,
           evaluation_reliability = 4, evaluation_adaptability = 4.3, evaluation_convention = 4.325,
           evaluation_effectiveness = 4.625, evaluation_checked_at = ?, summary_json = ?
       WHERE slug = 'fenced-score'`,
      [fixture.clock.value, JSON.stringify({ ...summary, id: "fenced-score", aliases: ["fenced-score"], evaluationScore: 4.45, traceEvaluation: evaluationTrace(fixture.clock.value) })],
    )
    let changed = false
    const publisher = createPublisher({
      ...publisherOptions(fixture),
      store: {
        ...fixture.store,
        async get(key) {
          const body = await fixture.store.get(key)
          if (!changed && key === `skill-market/details/${staleSha256}.json`) {
            changed = true
            fixture.database.connection.run(
              `UPDATE skillhub_import_items
               SET detail_key = ?, detail_sha256 = ?, evaluation_score = 4.8, evaluation_checked_at = ?, summary_json = ?
               WHERE slug = 'fenced-score'`,
              [
                `details/${currentSha256}.json`,
                currentSha256,
                fixture.clock.value + 1,
                JSON.stringify({ ...summary, id: "fenced-score", aliases: ["fenced-score"], description: currentDetail.description, evaluationScore: 4.8, traceEvaluation: evaluationTrace(fixture.clock.value + 1) }),
              ],
            )
          }
          return body
        },
      },
    })

    await publisher.publishMirroredSkillHub(imports, "worker-fenced")

    const published = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    expect(published.details.get("skillhub:fenced-score")).toMatchObject({ description: "newer mirror detail" })
    expect(published.details.get("skillhub:fenced-score")?.evaluationScore).toBeUndefined()
    expect(published.items.find((item) => item.id === "fenced-score")?.evaluationScore).toBeUndefined()
    expect(
      fixture.database.connection
        .query<{ readonly detail_sha256: string; readonly evaluation_score: number }, [string]>("SELECT detail_sha256, evaluation_score FROM skillhub_import_items WHERE slug = ?")
        .get("fenced-score"),
    ).toEqual({ detail_sha256: currentSha256, evaluation_score: 4.8 })
    fixture.database.close()
  })

  test("defers an upstream transition that arrives after score publication admission until its pointer commits", async () => {
    const fixture = await publisherFixture()
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    const summary = snapshot.items.find((item) => item.source === "skillhub")!
    const original = snapshot.details.get(`skillhub:${summary.id}`)!
    const detail = { ...original, id: "pointer-fenced-score", aliases: ["pointer-fenced-score"] }
    const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(detail)).digest("hex")
    fixture.objects.set(`skill-market/details/${detailSha256}.json`, bytes(JSON.stringify(detail)))
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    imports.seedLegacy([{
      slug: "pointer-fenced-score",
      summary: { ...summary, id: "pointer-fenced-score", aliases: ["pointer-fenced-score"] },
      detailKey: `details/${detailSha256}.json`,
      detailSha256,
    }])
    fixture.database.connection.run(
      `UPDATE skillhub_import_items
       SET evaluation_state = 'completed', evaluation_score = 4.45, evaluation_trust = 5,
           evaluation_reliability = 4, evaluation_adaptability = 4.3, evaluation_convention = 4.325,
           evaluation_effectiveness = 4.625, evaluation_checked_at = ?, summary_json = ?
       WHERE slug = 'pointer-fenced-score'`,
      [fixture.clock.value, JSON.stringify({ ...summary, id: "pointer-fenced-score", aliases: ["pointer-fenced-score"], evaluationScore: 4.45, traceEvaluation: evaluationTrace(fixture.clock.value) })],
    )
    const generation = imports.beginGeneration(1)
    let transitioned = false
    const publisher = createPublisher({
      ...publisherOptions(fixture),
      store: {
        ...fixture.store,
        async put(key, body, contentType, cacheControl, metadata) {
          if (!transitioned && key === "skill-market/current.json") {
            transitioned = true
            imports.recordPage(generation.id, 1, [updatedListRecord("pointer-fenced-score", fixture.clock.value + 1)])
            expect(
              fixture.database.connection
                .query<{ readonly state: string; readonly detail_sha256: string; readonly evaluation_state: string }, [string]>(
                  "SELECT state, detail_sha256, evaluation_state FROM skillhub_import_items WHERE slug = ?",
                )
                .get("pointer-fenced-score"),
            ).toEqual({ state: "mirrored", detail_sha256: detailSha256, evaluation_state: "completed" })
          }
          await fixture.store.put(key, body, contentType, cacheControl, metadata)
        },
      },
    })

    await publisher.publishMirroredSkillHub(imports, "worker-pointer-fence")

    expect(transitioned).toBe(true)
    const published = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    expect(published.details.get("skillhub:pointer-fenced-score")?.evaluationScore).toBe(4.45)
    imports.recordPage(generation.id, 1, [updatedListRecord("pointer-fenced-score", fixture.clock.value + 1)])
    expect(
      fixture.database.connection
        .query<{ readonly upstream_version: string; readonly state: string; readonly evaluation_state: string }, [string]>(
          "SELECT upstream_version, state, evaluation_state FROM skillhub_import_items WHERE slug = ?",
        )
        .get("pointer-fenced-score"),
    ).toEqual({ upstream_version: "1.0.1", state: "pending", evaluation_state: "waiting" })
    fixture.database.close()
  })

  test("seeds all legacy SkillHub entries into the import store without downloading packages", async () => {
    const fixture = await publisherFixture()
    fixture.database.connection.run("DELETE FROM publish_jobs")
    const details = Array.from({ length: 18 }, (_, index) =>
      sampleDetail({ id: `legacy-${index}`, aliases: [`legacy-slug-${index}`] }),
    )
    const createdAt = "2026-07-15T00:00:00.000Z"
    fixture.objects.set("skill-market/current.json", bytes(JSON.stringify({ revision: "legacy", createdAt })))
    fixture.objects.set(
      "skill-market/indexes/legacy/catalog.json",
      bytes(JSON.stringify({ revision: "legacy", createdAt, items: details.map((detail) => ({ ...sampleSnapshot().items[0]!, id: detail.id, aliases: detail.aliases })) })),
    )
    fixture.objects.set(
      "skill-market/indexes/legacy/facets.json",
      bytes(JSON.stringify({ ...sampleSnapshot().facets, revision: "legacy" })),
    )
    details.forEach((detail) =>
      fixture.objects.set(`skill-market/indexes/legacy/details/skillhub/${encodeURIComponent(detail.id)}.json`, bytes(JSON.stringify(detail))),
    )
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })

    expect(await createPublisher(publisherOptions(fixture)).seedLegacySkillHub(imports, "worker-migration")).toBe(18)
    expect(imports.mirroredEntries()).toHaveLength(18)
    expect((await loadCatalogIndex(fixture.store, { prefix: "skill-market" })).items).toHaveLength(18)
    fixture.database.connection.run(
      "INSERT INTO publish_jobs (id, submission_id, kind, status, attempts, created_at, updated_at) VALUES ('job_after_migration', 'sub_publish_12345678', 'publish', 'pending', 0, ?, ?)",
      [fixture.clock.value, fixture.clock.value],
    )
    await createPublisher(publisherOptions(fixture)).runOne("worker-community")
    expect((await loadCatalogIndex(fixture.store, { prefix: "skill-market" })).items).toHaveLength(19)
    expect(Array.from(fixture.objects).filter(([key]) => /\/packages\/[a-f0-9]{64}\.zip$/.test(key))).toEqual([])
    fixture.database.close()
  })

  test("does not read the legacy catalog after the import store has already been seeded", async () => {
    const fixture = await publisherFixture()
    const detail = sampleSnapshot("seeded").details.get("skillhub:code-review")!
    const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(detail)).digest("hex")
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    imports.seedLegacy([{
      slug: detail.id,
      summary: sampleSnapshot("seeded").items[0]!,
      detailKey: `details/${detailSha256}.json`,
      detailSha256,
    }])
    const reads = { total: 0 }
    const publisher = createPublisher({
      ...publisherOptions(fixture),
      store: {
        ...fixture.store,
        async get(key: string) {
          reads.total++
          return fixture.store.get(key)
        },
      },
    })

    expect(await publisher.seedLegacySkillHub(imports, "worker-resume")).toBe(0)
    expect(reads.total).toBe(0)
    fixture.database.close()
  })

  test("converts a legacy catalog without loading replaced SkillHub details", async () => {
    const fixture = await publisherFixture()
    await createPublisher(publisherOptions(fixture)).runOne("worker-community")
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    const createdAt = "2026-07-15T02:00:00.000Z"
    fixture.objects.set("skill-market/current.json", bytes(JSON.stringify({ revision: "legacy-mixed", createdAt })))
    fixture.objects.set(
      "skill-market/indexes/legacy-mixed/catalog.json",
      bytes(JSON.stringify({ revision: "legacy-mixed", createdAt, items: snapshot.items })),
    )
    fixture.objects.set(
      "skill-market/indexes/legacy-mixed/facets.json",
      bytes(JSON.stringify({ ...snapshot.facets, revision: "legacy-mixed" })),
    )
    snapshot.details.forEach((detail) =>
      fixture.objects.set(
        `skill-market/indexes/legacy-mixed/details/${detail.source}/${encodeURIComponent(detail.id)}.json`,
        bytes(JSON.stringify(detail)),
      ),
    )
    const detail = snapshot.details.get("skillhub:code-review")!
    const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(detail)).digest("hex")
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    imports.seedLegacy([{
      slug: detail.id,
      summary: snapshot.items.find((item) => item.source === "skillhub")!,
      detailKey: `details/${detailSha256}.json`,
      detailSha256,
    }])
    const reads = { skillhubDetails: 0 }
    const publisher = createPublisher({
      ...publisherOptions(fixture),
      store: {
        ...fixture.store,
        async get(key: string) {
          if (key.includes("/details/skillhub/")) reads.skillhubDetails++
          return fixture.store.get(key)
        },
      },
    })

    await publisher.publishMirroredSkillHub(imports, "worker-mirror")

    expect(reads.skillhubDetails).toBe(0)
    expect((await loadCatalogIndex(fixture.store, { prefix: "skill-market" })).items).toHaveLength(2)
    fixture.database.close()
  })

  test("publishes 2,000 mirrored summaries without loading their detail objects under the catalog lease", async () => {
    const fixture = await publisherFixture()
    await createPublisher(publisherOptions(fixture)).runOne("worker-community")
    const imports = createSkillHubImportStore({ database: fixture.database, now: () => fixture.clock.value })
    const generation = imports.beginGeneration(2_000)
    const detail = sampleSnapshot("mirrored").details.get("skillhub:code-review")!
    const detailSha256 = new Bun.CryptoHasher("sha256").update(JSON.stringify(detail)).digest("hex")
    const summary = { ...sampleSnapshot("mirrored").items[0]!, id: "mirrored" }
    fixture.database.transaction((connection) => {
      Array.from({ length: 2_000 }, (_, index) => {
        const slug = `mirrored-${index}`
        connection.run(
          "INSERT INTO skillhub_import_items (slug, generation_id, upstream_version, upstream_updated_at, state, list_json, summary_json, detail_key, detail_sha256, mirrored_at, last_seen_generation, created_at, updated_at) VALUES (?, ?, '1.0.0', ?, 'mirrored', '{}', ?, ?, ?, ?, ?, ?, ?)",
          [
            slug,
            generation.id,
            fixture.clock.value,
            JSON.stringify({ ...summary, id: slug }),
            `details/${detailSha256}.json`,
            detailSha256,
            fixture.clock.value,
            generation.id,
            fixture.clock.value,
            fixture.clock.value,
          ],
        )
      })
    })
    const reads = { details: 0 }
    const store = {
      ...fixture.store,
      async get(key: string) {
        if (key.includes("/details/")) reads.details++
        return fixture.store.get(key)
      },
    }
    const publisher = createPublisher({ ...publisherOptions(fixture), store })

    await publisher.publishMirroredSkillHub(imports, "worker-mirror", new Set(["mirrored-0"]))

    expect(reads.details).toBe(0)
    expect(imports.recordPublication(imports.progress().mirrored)).toBe(true)
    const index = await loadCatalogIndex(fixture.store, { prefix: "skill-market" })
    expect(index.items).toHaveLength(2_001)
    expect(index.items.find((item) => item.id === "mirrored-0")?.featured).toBe(true)
    expect(index.items.find((item) => item.id === "mirrored-1")?.featured).toBe(false)
    fixture.database.close()
  })

  test("leases one pending job across concurrent workers and publishes exactly once", async () => {
    const fixture = await publisherFixture()
    const publisher = createPublisher(publisherOptions(fixture))
    const results = await Promise.all([publisher.runOne("worker-a"), publisher.runOne("worker-b")])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(
      fixture.database.connection
        .query<{ status: string }, []>("SELECT status FROM submissions WHERE id = 'sub_publish_12345678'")
        .get()?.status,
    ).toBe("published")
    expect(
      fixture.database.connection.query<{ status: string }, []>("SELECT status FROM publish_jobs").get()?.status,
    ).toBe("completed")
    expect(fixture.copies.filter((copy) => copy.includes("packages/community"))).toHaveLength(1)
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    expect(snapshot.details.get("community:community-publish")).toMatchObject({
      version: "1.0.0",
      submittedBy: { displayName: "CONTRIBUTOR" },
    })
    expect(
      fixture.database.connection
        .query<{ action: string }, []>(
          "SELECT action FROM audit_events WHERE action IN ('publish-started', 'publish-succeeded') ORDER BY rowid",
        )
        .all()
        .map((event) => event.action),
    ).toEqual(["publish-started", "publish-succeeded"])

    fixture.database.close()
  })

  test("finalizes an expired pointer-ahead job without republishing immutable objects", async () => {
    const fixture = await publisherFixture()
    const publisher = createPublisher(publisherOptions(fixture))
    await publisher.runOne("worker-a")
    const copies = fixture.copies.length
    fixture.clock.value += 60_000
    fixture.database.transaction((connection) => {
      connection.run(
        `UPDATE publish_jobs
         SET status = 'running', lease_owner = 'crashed-worker', lease_expires_at = ?, updated_at = ?`,
        [fixture.clock.value - 1, fixture.clock.value - 1],
      )
      connection.run(
        "UPDATE submissions SET status = 'publishing', version = version + 1 WHERE id = 'sub_publish_12345678'",
      )
      connection.run(
        `UPDATE community_skills
         SET current_version = NULL, current_submission_id = NULL, public_status = NULL, version = version + 1
         WHERE skill_id = 'community-publish'`,
      )
    })

    expect(await publisher.recover()).toBe(1)
    expect(fixture.copies).toHaveLength(copies)
    expect(
      fixture.database.connection.query<{ status: string }, []>("SELECT status FROM publish_jobs").get()?.status,
    ).toBe("completed")
    expect(
      fixture.database.connection
        .query<{ current_version: string }, []>("SELECT current_version FROM community_skills")
        .get()?.current_version,
    ).toBe("1.0.0")

    fixture.database.close()
  })

  test("retries immutable work after the pointer write fails and the lease expires", async () => {
    const fixture = await publisherFixture()
    const publisher = createPublisher(publisherOptions(fixture))
    fixture.failures.put = /current\.json$/

    const failure = await rejected(publisher.runOne("worker-a"))
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("configured put failure")
    expect(
      fixture.database.connection
        .query<
          { target_revision: string | null; status: string },
          []
        >("SELECT target_revision, status FROM publish_jobs")
        .get(),
    ).toMatchObject({ status: "running" })
    expect((await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })).revision).toBe("initial")

    fixture.failures.put = undefined
    fixture.clock.value += 60_000
    expect(await publisher.recover()).toBe(1)
    await publisher.runOne("worker-b")
    expect(
      fixture.database.connection
        .query<{ status: string; attempts: number }, []>("SELECT status, attempts FROM publish_jobs")
        .get(),
    ).toEqual({ status: "completed", attempts: 2 })
    expect(fixture.copies.filter((copy) => copy.includes("packages/community"))).toHaveLength(2)

    fixture.database.close()
  })

  test("recovers a pointer moved before the final database transaction", async () => {
    const fixture = await publisherFixture()
    const publisher = createPublisher(publisherOptions(fixture))
    fixture.database.connection.run(
      `CREATE TRIGGER fail_publish_finalize
       BEFORE INSERT ON audit_events
       WHEN NEW.action = 'publish-succeeded'
       BEGIN
         SELECT RAISE(ABORT, 'configured finalization failure');
       END`,
    )

    const failure = await rejected(publisher.runOne("worker-a"))
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("configured finalization failure")
    const pointer = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    expect(pointer.details.has("community:community-publish")).toBe(true)
    expect(
      fixture.database.connection.query<{ status: string }, []>("SELECT status FROM submissions").get()?.status,
    ).toBe("publishing")
    const copies = fixture.copies.length

    fixture.database.connection.run("DROP TRIGGER fail_publish_finalize")
    fixture.clock.value += 60_000
    expect(await publisher.recover()).toBe(1)
    expect(fixture.copies).toHaveLength(copies)
    expect(
      fixture.database.connection.query<{ status: string }, []>("SELECT status FROM submissions").get()?.status,
    ).toBe("published")

    fixture.database.close()
  })

  test("rebuilds the catalog after a published community skill is delisted", async () => {
    const fixture = await publisherFixture()
    const publisher = createPublisher(publisherOptions(fixture))
    await publisher.runOne("worker-a")
    fixture.database.transaction((connection) => {
      connection.run(
        `UPDATE community_skills
         SET public_status = 'delisted', delist_reason = 'Policy review', version = version + 1
         WHERE skill_id = 'community-publish'`,
      )
      connection.run(
        `INSERT INTO publish_jobs (id, kind, status, attempts, created_at, updated_at)
         VALUES ('job_rebuild_12345678', 'catalog_rebuild', 'pending', 0, ?, ?)`,
        [fixture.clock.value, fixture.clock.value],
      )
    })

    await publisher.runOne("worker-b")
    const snapshot = await loadCurrentSnapshot(fixture.store, { prefix: "skill-market" })
    expect(snapshot.details.has("community:community-publish")).toBe(false)
    expect(snapshot.sourceStatus.community).toBe("fresh")
    expect(fixture.copies.filter((copy) => copy.includes("packages/community"))).toHaveLength(1)

    fixture.database.close()
  })
})

async function publisherFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-publisher-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const archive = makeStoredZip({
    "SKILL.md": "---\nname: community-publish\ndescription: Publish safely\n---\n# Community Publish\n",
  })
  const metadata = {
    version: "1.0.0",
    displayName: "Community Publish",
    description: "Publish safely",
    category: "Development",
    tags: ["publish"],
    license: "MIT",
    requiresApiKey: false,
    changeNotes: "Initial release",
  } as const
  const validation = validateSubmissionArchive(archive, metadata, () => Date.parse("2026-07-15T00:30:00.000Z"))
  const objects = new Map<string, Uint8Array>([["private/sub_publish_12345678/package.zip", archive]])
  const metadataByKey = new Map<string, Readonly<Record<string, string>>>()
  const copies: string[] = []
  const failures: { put?: RegExp } = {}
  const store = memoryStore(objects, metadataByKey, copies, failures)
  await publishSnapshot(store, { prefix: "skill-market" }, sampleSnapshot("initial"))
  const clock = { value: Date.parse("2026-07-15T01:00:00.000Z") }
  database.transaction((connection) => {
    connection.run(
      "INSERT INTO users (employee_id, display_name, email, created_at, last_login_at) VALUES ('E123456', 'CONTRIBUTOR', 'contributor@example.com', ?, ?)",
      [clock.value, clock.value],
    )
    connection.run(
      `INSERT INTO submissions
        (id, skill_id, owner_employee_id, target_version, status, current_revision, version, created_at, updated_at)
       VALUES ('sub_publish_12345678', 'community-publish', 'E123456', '1.0.0', 'publishing', 1, 3, ?, ?)`,
      [clock.value, clock.value],
    )
    connection.run(
      `INSERT INTO submission_revisions
        (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json,
         manifest_json, scan_json, validation_errors_json, validation_completed_at, created_at)
       VALUES ('sub_publish_12345678', 1, 'private/sub_publish_12345678/package.zip', ?, ?, ?, ?, ?, '[]', ?, ?)`,
      [
        validation.manifest.packageSha256,
        archive.byteLength,
        JSON.stringify(metadata),
        JSON.stringify(validation.manifest),
        JSON.stringify(validation.scan),
        clock.value,
        clock.value,
      ],
    )
    connection.run(
      `INSERT INTO reviews
        (id, submission_id, revision_number, reviewer_employee_id, decision, created_at)
       VALUES ('review_publish_12345678', 'sub_publish_12345678', 1, 'E123456', 'approve', ?)`,
      [clock.value],
    )
    connection.run(
      `INSERT INTO community_skills
        (skill_id, owner_employee_id, version, created_at, updated_at)
       VALUES ('community-publish', 'E123456', 1, ?, ?)`,
      [clock.value, clock.value],
    )
    connection.run(
      `INSERT INTO publish_jobs
        (id, submission_id, kind, status, attempts, created_at, updated_at)
       VALUES ('job_publish_12345678', 'sub_publish_12345678', 'publish', 'pending', 0, ?, ?)`,
      [clock.value, clock.value],
    )
  })
  return { database, store, objects, metadataByKey, copies, failures, clock, validation }
}

function publisherOptions(fixture: Awaited<ReturnType<typeof publisherFixture>>) {
  return {
    database: fixture.database,
    store: fixture.store,
    ossPrefix: "skill-market",
    publicBaseUrl: "https://oss.example.com/skill-market/",
    webBaseUrl: "https://market.example.com/",
    leaseMilliseconds: 30_000,
    now: () => fixture.clock.value,
  }
}

function memoryStore(
  objects: Map<string, Uint8Array>,
  metadataByKey: Map<string, Readonly<Record<string, string>>>,
  copies: string[],
  failures: { put?: RegExp },
): PrivateObjectStore {
  return {
    async put(key, body) {
      if (failures.put?.test(key)) throw new Error(`configured put failure for ${key}`)
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
    },
    async get(key) {
      const body = objects.get(key)
      if (!body) throw new Error(`missing ${key}`)
      return body
    },
    async head(key) {
      const body = objects.get(key)
      if (!body) throw new Error(`missing ${key}`)
      return { size: body.byteLength, metadata: metadataByKey.get(key) }
    },
    async putPrivate(key, body) {
      const chunks = await Array.fromAsync(body)
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      const output = new Uint8Array(size)
      chunks.reduce((offset, chunk) => {
        output.set(chunk, offset)
        return offset + chunk.byteLength
      }, 0)
      objects.set(key, output)
    },
    async copy(source, target, _contentType, metadata) {
      const body = objects.get(source)
      if (!body) throw new Error(`missing ${source}`)
      objects.set(target, body.slice())
      if (metadata) metadataByKey.set(target, metadata)
      copies.push(`${source}->${target}`)
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

function rejected<T>(promise: Promise<T>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

function bytes(value: string) {
  return new TextEncoder().encode(value)
}

async function waitFor(condition: () => boolean) {
  while (!condition()) await Promise.resolve()
}

function evaluationTrace(checkedAt: number) {
  return {
    ...evaluationValues(),
    evaluatedAt: new Date(checkedAt).toISOString(),
  }
}

function evaluationValues() {
  return {
    trust: 5,
    reliability: 4,
    adaptability: 4.3,
    convention: 4.325,
    effectiveness: 4.625,
  }
}

function updatedListRecord(slug: string, updatedAt: number) {
  return {
    category: "tools",
    description: `${slug} updated`,
    downloads: 1,
    installs: 1,
    name: slug,
    ownerName: "owner",
    score: 1,
    slug,
    source: "https://example.com/source",
    stars: 1,
    subCategories: [],
    updated_at: updatedAt,
    version: "1.0.1",
  }
}
