import { expect, test } from "bun:test"

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
  const metrics = JSON.parse(output) as { readonly elapsedMilliseconds: number; readonly maxRssKilobytes: number; readonly items: number }
  expect(metrics.items).toBe(80_000)
  expect(metrics.elapsedMilliseconds).toBeLessThan(45_000)
  expect(metrics.maxRssKilobytes).toBeLessThan(1024 * 1024)
}, 50_000)
