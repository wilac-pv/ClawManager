import { expect, test } from "bun:test"
import { readlink, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  publishWebRelease,
  requireOssEndpoint,
  rollbackWebRelease,
  stageLocalWebRelease,
  type WebReleaseStore,
} from "./release"

test("publishes immutable files and advances the pointer only after verification", async () => {
  const directory = join(tmpdir(), `ruying-market-release-${crypto.randomUUID()}`)
  await Promise.all([
    Bun.write(join(directory, "index.html"), "<main>market</main>"),
    Bun.write(join(directory, "assets/index-abc123.js"), "console.log('market')"),
  ])
  const events: string[] = []
  const objects = new Map<string, { body: Uint8Array; cacheControl: string; contentType: string }>()
  const store: WebReleaseStore = {
    put: async (key, body, contentType, cacheControl) => {
      events.push(`put:${key}`)
      objects.set(key, {
        body: typeof body === "string" ? new TextEncoder().encode(body) : body,
        cacheControl,
        contentType,
      })
    },
    head: async (key) => {
      events.push(`head:${key}`)
      const value = objects.get(key)
      if (!value) throw new Error(`missing ${key}`)
      return { size: value.body.byteLength }
    },
  }

  const result = await publishWebRelease(store, {
    directory,
    prefix: "ai-coding/ruying-code/skill-market/web",
    createdAt: "2026-07-15T02:00:00.000Z",
  })
  const releaseRoot = `ai-coding/ruying-code/skill-market/web/${result.release}`
  const pointerKey = "ai-coding/ruying-code/skill-market/web/current.json"

  expect(result.release).toMatch(/^[a-f0-9]{16}$/)
  expect(objects.get(`${releaseRoot}/index.html`)?.cacheControl).toBe("public, max-age=60")
  expect(objects.get(`${releaseRoot}/assets/index-abc123.js`)?.cacheControl).toBe("public, max-age=31536000, immutable")
  expect(objects.get(`${releaseRoot}/manifest.json`)?.contentType).toBe("application/json; charset=utf-8")
  expect(events.at(-1)).toBe(`put:${pointerKey}`)
  expect(events.indexOf(`head:${releaseRoot}/index.html`)).toBeLessThan(events.indexOf(`put:${pointerKey}`))
  const pointer = JSON.parse(new TextDecoder().decode(objects.get(pointerKey)?.body))
  expect(pointer).toMatchObject({
    release: result.release,
    entry: `${releaseRoot}/index.html`,
    fallback: `${releaseRoot}/index.html`,
  })
  expect(pointer.fallbacks).toEqual(
    Object.fromEntries(
      [
        "/skills",
        "/skills/:source/:id",
        "/submissions",
        "/submissions/new",
        "/submissions/:id",
        "/admin",
        "/admin/submissions/:id",
        "/admin/roles",
        "/admin/audit",
        "/admin/skillhub",
      ].map((route) => [route, `${releaseRoot}/index.html`]),
    ),
  )

  await Bun.write(join(directory, "index.html"), "<main>market v2</main>")
  const next = await publishWebRelease(store, {
    directory,
    prefix: "ai-coding/ruying-code/skill-market/web",
    createdAt: "2026-07-15T03:00:00.000Z",
  })
  expect(next.release).not.toBe(result.release)
  await rollbackWebRelease(store, {
    release: result.release,
    prefix: "ai-coding/ruying-code/skill-market/web",
    createdAt: "2026-07-15T04:00:00.000Z",
  })
  expect(JSON.parse(new TextDecoder().decode(objects.get(pointerKey)?.body))).toMatchObject({
    release: result.release,
    entry: `${releaseRoot}/index.html`,
    fallbacks: pointer.fallbacks,
  })
  expect(events.at(-1)).toBe(`put:${pointerKey}`)

  await rm(directory, { recursive: true, force: true })
})

test("stages verified releases locally and switches the current symlink atomically", async () => {
  const directory = join(tmpdir(), `ruying-market-release-source-${crypto.randomUUID()}`)
  const root = join(tmpdir(), `ruying-market-release-root-${crypto.randomUUID()}`)
  await Promise.all([
    Bun.write(join(directory, "index.html"), "<main>market</main>"),
    Bun.write(join(directory, "assets/index-abc123.js"), "console.log('market')"),
  ])
  const first = await stageLocalWebRelease({ directory, root, createdAt: "2026-07-16T02:00:00.000Z" })
  expect(await readlink(join(root, "current"))).toBe(`releases/${first.release}`)
  expect(await Bun.file(join(root, "releases", first.release, "index.html")).text()).toContain("market")

  await Bun.write(join(directory, "index.html"), "<main>market v2</main>")
  const second = await stageLocalWebRelease({ directory, root, createdAt: "2026-07-16T03:00:00.000Z" })
  expect(second.release).not.toBe(first.release)
  expect(await readlink(join(root, "current"))).toBe(`releases/${second.release}`)
  expect(await Bun.file(join(root, "releases", first.release, "index.html")).exists()).toBe(true)

  await expect(
    stageLocalWebRelease({ directory, root, expectedRelease: "0".repeat(16) }),
  ).rejects.toThrow("release identity mismatch")
  expect(await readlink(join(root, "current"))).toBe(`releases/${second.release}`)
  await Promise.all([rm(directory, { recursive: true, force: true }), rm(root, { recursive: true, force: true })])
})

test("requires an explicit flag for credential-free HTTP OSS endpoints", () => {
  expect(() => requireOssEndpoint("http://oss.internal.example.com", false)).toThrow(
    "SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP=true",
  )
  expect(requireOssEndpoint("http://oss.internal.example.com", true)).toBe("http://oss.internal.example.com/")
  expect(() => requireOssEndpoint("http://user:secret@oss.internal.example.com", true)).toThrow(
    "without credentials",
  )
})
