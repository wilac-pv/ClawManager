import { expect, test } from "bun:test"
import { queryCatalog, type CatalogSnapshot } from "../src/catalog"
import { sampleSnapshot } from "./fixture"

test("queries 80000 cached summaries within the 300 ms p95 budget", () => {
  const snapshot = benchmarkSnapshot(80_000)
  queryCatalog(snapshot, { query: "typescript", sort: "score", page: 1, limit: 30 })
  const samples = Array.from({ length: 100 }, () => {
    const started = performance.now()
    queryCatalog(snapshot, { query: "typescript", sort: "score", page: 1, limit: 30 })
    return performance.now() - started
  }).toSorted((left, right) => left - right)
  expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(300)
}, 20_000)

function benchmarkSnapshot(count: number): CatalogSnapshot {
  const snapshot = sampleSnapshot("benchmark")
  const original = snapshot.items[0]
  return {
    ...snapshot,
    items: Array.from({ length: count }, (_, index) => ({
      ...original,
      id: `skill-${index}`,
      name: `TypeScript Skill ${index}`,
      score: count - index,
    })),
    details: new Map(),
  }
}
