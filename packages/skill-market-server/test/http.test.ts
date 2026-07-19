import { describe, expect, test } from "bun:test"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { createCatalogHandler } from "../src/handlers"
import { createCatalogPackageReader, MAX_CATALOG_PACKAGE_SIZE } from "../src/package-reader"
import type { ObjectStore } from "../src/oss"
import { sampleDetail, sampleSnapshot } from "./fixture"

describe("catalog HTTP", () => {
  test("serves all public operations from one loaded revision", async () => {
    const snapshot = sampleSnapshot("r1")
    let loads = 0
    const handler = createCatalogHandler(async () => {
      loads++
      return snapshot
    })

    const page = await handler(new Request("https://market.example.com/v1/catalog/skills?page=1&limit=30"))
    expect(page.status).toBe(200)
    expect(page.headers.get("x-skill-market-revision")).toBe("r1")
    expect(page.headers.get("access-control-allow-origin")).toBe("*")
    expect(page.headers.has("access-control-allow-credentials")).toBe(false)
    expect(Schema.decodeUnknownSync(SkillMarket.Page)(await page.json()).items).toHaveLength(1)

    const detail = await handler(new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review"))
    expect(detail.status).toBe(200)
    expect(Schema.decodeUnknownSync(SkillMarket.Detail)(await detail.json()).id).toBe("code-review")

    const versions = await handler(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/versions"),
    )
    expect(Schema.decodeUnknownSync(Schema.Array(SkillMarket.Version))(await versions.json())[0]?.version).toBe("1.0.0")

    const download = await handler(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/download"),
    )
    expect(await download.json()).toEqual({
      url: "https://packages.example.com/code-review.zip",
      sha256: "a".repeat(64),
      size: 2000,
    })
    expect(loads).toBe(4)
  })

  test("handles preflight without loading the catalog and rejects invalid queries", async () => {
    let loads = 0
    const handler = createCatalogHandler(async () => {
      loads++
      return sampleSnapshot("r1")
    })
    const preflight = await handler(new Request("https://market.example.com/v1/catalog/skills", { method: "OPTIONS" }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS")
    expect(loads).toBe(0)

    const invalid = await handler(new Request("https://market.example.com/v1/catalog/skills?page=0"))
    expect(invalid.status).toBe(400)
    expect(loads).toBe(1)
  })

  test("does not expose delisted details", async () => {
    const snapshot = sampleSnapshot("r1")
    snapshot.details.set("skillhub:code-review", sampleDetail({ delisted: true }))
    const response = await createCatalogHandler(async () => snapshot)(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review"),
    )
    expect(response.status).toBe(404)
  })

  test("serves community detail routes and source freshness headers", async () => {
    const snapshot = sampleSnapshot("r1")
    const detail = sampleDetail({
      source: "community",
      sourceUrl: "https://market.example.com/skills/community/code-review",
      publicDetailUrl: "https://market.example.com/skills/community/code-review",
      submittedBy: { displayName: "CONTRIBUTOR" },
      author: { name: "CONTRIBUTOR" },
    })
    snapshot.details.set("community:code-review", detail)
    snapshot.sourceStatus = { ...snapshot.sourceStatus, community: "fresh" }
    const response = await createCatalogHandler(async () => snapshot)(
      new Request("https://market.example.com/v1/catalog/skills/community/code-review"),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("x-skill-market-source-community")).toBe("fresh")
    expect(Schema.decodeUnknownSync(SkillMarket.Detail)(await response.json()).source).toBe("community")
  })

  test("serves verified GET and HEAD package responses", async () => {
    const fixture = packageFixture()
    const handler = createCatalogHandler(async () => fixture.snapshot, fixture.packages)

    const get = await handler(new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/package"))
    expect(get.status).toBe(200)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(fixture.body)
    expect(get.headers.get("content-type")).toBe("application/zip")
    expect(get.headers.get("content-length")).toBe(String(fixture.body.byteLength))
    expect(get.headers.get("etag")).toBe(`"${fixture.sha256}"`)
    expect(get.headers.get("x-content-sha256")).toBe(fixture.sha256)
    expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(get.headers.get("content-disposition")).toBe('attachment; filename="skillhub-code-review-1.0.0.zip"')
    expect(get.headers.get("x-content-type-options")).toBe("nosniff")

    const head = await handler(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/package", {
        method: "HEAD",
      }),
    )
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(head.headers.get("content-type")).toBe("application/zip")
    expect(head.headers.get("content-length")).toBe(String(fixture.body.byteLength))
    expect(head.headers.get("etag")).toBe(`"${fixture.sha256}"`)
    expect(head.headers.get("x-content-sha256")).toBe(fixture.sha256)
    expect(head.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(head.headers.get("content-disposition")).toBe('attachment; filename="skillhub-code-review-1.0.0.zip"')
    expect(head.headers.get("x-content-type-options")).toBe("nosniff")
    expect(fixture.store.getCalls).toBe(2)
  })

  test.each([
    {
      name: "absent detail",
      status: 404,
      detail: "absent" as const,
      code: "skill-market-not-found",
      message: "Skill 包不存在",
    },
    {
      name: "delisted detail",
      status: 404,
      detail: "delisted" as const,
      code: "skill-market-not-found",
      message: "Skill 包不存在",
    },
    {
      name: "declared oversize",
      status: 413,
      detail: "present" as const,
      size: MAX_CATALOG_PACKAGE_SIZE + 1,
      code: "skill-market-package-too-large",
      message: "Skill 包超过大小限制",
    },
    {
      name: "stored oversize",
      status: 413,
      detail: "present" as const,
      headSize: MAX_CATALOG_PACKAGE_SIZE + 1,
      code: "skill-market-package-too-large",
      message: "Skill 包超过大小限制",
    },
    {
      name: "missing object",
      status: 502,
      detail: "present" as const,
      missingHead: true,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
    },
    {
      name: "length mismatch",
      status: 502,
      detail: "present" as const,
      headSize: 1,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
    },
    {
      name: "SHA mismatch",
      status: 502,
      detail: "present" as const,
      corruptBody: true,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
    },
  ])("returns a bounded package problem for $name", async (options) => {
    const fixture = packageFixture(options)
    const response = await createCatalogHandler(
      async () => fixture.snapshot,
      fixture.packages,
    )(new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/package"))

    expect(response.status).toBe(options.status)
    expect(await response.json()).toEqual({
      code: options.code,
      message: options.message,
      source: "skillhub",
      id: "code-review",
      requestId: expect.any(String),
    })
    if (options.detail === "absent" || options.detail === "delisted") {
      expect(fixture.store.headCalls).toBe(0)
      expect(fixture.store.getCalls).toBe(0)
    }
  })

  test.each([
    { name: "absent detail", status: 404, detail: "absent" as const },
    {
      name: "declared oversize",
      status: 413,
      detail: "present" as const,
      size: MAX_CATALOG_PACKAGE_SIZE + 1,
    },
    { name: "missing object", status: 502, detail: "present" as const, missingHead: true },
  ])("returns an empty HEAD package problem for $name", async (options) => {
    const fixture = packageFixture(options)
    const response = await createCatalogHandler(
      async () => fixture.snapshot,
      fixture.packages,
    )(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/package", {
        method: "HEAD",
      }),
    )

    expect(response.status).toBe(options.status)
    expect(await response.text()).toBe("")
  })

  test("returns the existing unavailable problem when snapshot loading fails", async () => {
    const fixture = packageFixture()
    const response = await createCatalogHandler(async () => {
      throw new Error("snapshot unavailable")
    }, fixture.packages)(new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/package"))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: "market-unavailable", message: "Skill 市场暂不可用" })
  })

  test("returns an empty HEAD problem when snapshot loading fails", async () => {
    const fixture = packageFixture()
    const response = await createCatalogHandler(async () => {
      throw new Error("snapshot unavailable")
    }, fixture.packages)(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/package", { method: "HEAD" }),
    )

    expect(response.status).toBe(503)
    expect(await response.text()).toBe("")
  })

  test("does not fall back to the catalog URL when no package reader is injected", async () => {
    const fixture = packageFixture({ canaryUrl: "https://attacker.example/never-fetch.zip" })
    const response = await createCatalogHandler(async () => fixture.snapshot)(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/package"),
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      source: "skillhub",
      id: "code-review",
      requestId: expect.any(String),
    })
    expect(fixture.store.keys).toEqual([])
  })

  test("uses trusted package identity instead of catalog URLs or encoded route traversal", async () => {
    const fixture = packageFixture({ canaryUrl: "https://attacker.example/never-fetch.zip" })
    const handler = createCatalogHandler(async () => fixture.snapshot, fixture.packages)

    expect(
      (await handler(new Request("https://market.example.com/v1/catalog/skills/skillhub/code-review/package"))).status,
    ).toBe(200)
    expect(fixture.store.keys).toEqual([
      `public-market/packages/${fixture.sha256}.zip`,
      `public-market/packages/${fixture.sha256}.zip`,
    ])
    expect(fixture.store.keys.join("\n")).not.toContain("attacker.example")

    const escaped = await handler(
      new Request("https://market.example.com/v1/catalog/skills/skillhub/%2e%2e%2fprivate/package"),
    )
    expect(escaped.status).toBe(404)
    expect(fixture.store.keys).toHaveLength(2)
    expect(fixture.store.keys.every((value) => value.startsWith("public-market/"))).toBe(true)
  })

  test("sanitizes schema-valid package identity in attachment filenames", async () => {
    const fixture = packageFixture({ id: "code+review", version: "1.0.0+build" })
    const response = await createCatalogHandler(
      async () => fixture.snapshot,
      fixture.packages,
    )(new Request("https://market.example.com/v1/catalog/skills/skillhub/code+review/package"))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="skillhub-code_review-1.0.0_build.zip"',
    )
  })
})

function packageFixture(
  options: {
    detail?: "present" | "absent" | "delisted"
    size?: number
    headSize?: number
    missingHead?: boolean
    corruptBody?: boolean
    canaryUrl?: string
    id?: string
    version?: string
  } = {},
) {
  const body = new TextEncoder().encode("verified package body")
  const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
  const storedBody = options.corruptBody ? body.map((value, index) => (index === 0 ? value ^ 1 : value)) : body
  const snapshot = sampleSnapshot("package-r1")
  snapshot.details.set(
    `skillhub:${options.id ?? "code-review"}`,
    sampleDetail({
      id: options.id ?? "code-review",
      delisted: options.detail === "delisted",
      version: options.version ?? "1.0.0",
      package: {
        ...sampleDetail().package,
        url: options.canaryUrl ?? sampleDetail().package.url,
        sha256,
        size: options.size ?? body.byteLength,
      },
    }),
  )
  if (options.detail === "absent") snapshot.details.delete(`skillhub:${options.id ?? "code-review"}`)
  const keys: string[] = []
  const calls = { head: 0, get: 0 }
  const client: ObjectStore = {
    async put() {},
    async head(key) {
      calls.head++
      keys.push(key)
      if (options.missingHead) throw new Error("object missing")
      return { size: options.headSize ?? body.byteLength }
    },
    async get(key) {
      calls.get++
      keys.push(key)
      return storedBody
    },
  }
  return {
    body,
    sha256,
    snapshot,
    packages: createCatalogPackageReader(client, "public-market"),
    store: {
      keys,
      get headCalls() {
        return calls.head
      },
      get getCalls() {
        return calls.get
      },
    },
  }
}
