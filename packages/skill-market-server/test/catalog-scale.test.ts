import { expect, test } from "bun:test"

test("samples catalog RSS after streaming the representative V2 payload", async () => {
  const fixture = await Bun.file(new URL("./catalog-scale-fixture.ts", import.meta.url)).text()

  expect(fixture.indexOf("const delta = await prepareCatalogDelta(")).toBeGreaterThanOrEqual(0)
  expect(fixture.indexOf("const maxRSS = process.resourceUsage().maxRSS")).toBeGreaterThan(
    fixture.indexOf("const delta = await prepareCatalogDelta("),
  )
})

test("patches 100 catalog entries in an 80,000-entry index within the worker budget", async () => {
  const child = Bun.spawn([process.execPath, new URL("./catalog-scale-fixture.ts", import.meta.url).pathname], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    new Promise<{ readonly exitCode: number; readonly timedOut: true }>((resolve) =>
      timeout = setTimeout(() => {
        child.kill()
        resolve({ exitCode: -1, timedOut: true })
      }, 45_000),
    ),
  ])
  if (timeout) clearTimeout(timeout)
  const output = await stdout
  const errors = await stderr

  expect(result.timedOut, errors).toBe(false)
  expect(result.exitCode, errors).toBe(0)
  const metrics = JSON.parse(output) as {
    readonly elapsedMilliseconds: number
    readonly maxRssKilobytes: number
    readonly items: number
    readonly catalogPayloadBytes: number
    readonly streamedBytes: number
  }
  expect(metrics.items).toBe(80_000)
  expect(metrics.catalogPayloadBytes).toBeGreaterThanOrEqual(60 * 1024 * 1024)
  expect(metrics.catalogPayloadBytes).toBeLessThanOrEqual(90 * 1024 * 1024)
  expect(metrics.streamedBytes).toBe(metrics.catalogPayloadBytes)
  expect(metrics.elapsedMilliseconds).toBeLessThan(45_000)
  expect(metrics.maxRssKilobytes).toBeLessThan(896 * 1024)
}, 50_000)
