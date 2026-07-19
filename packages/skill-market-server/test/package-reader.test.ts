import { describe, expect, test } from "bun:test"
import {
  CatalogPackageReadError,
  createCatalogPackageReader,
  MAX_CATALOG_PACKAGE_SIZE,
} from "../src/package-reader"
import type { ObjectStore } from "../src/oss"
import { sampleDetail } from "./fixture"

const body = new TextEncoder().encode("verified zip fixture")
const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
const publicPrefix = "public-market"

describe("catalog package reader", () => {
  test("reads trusted skillhub packages without requesting their catalog URL", async () => {
    const store = memoryObjectStore({ body })
    const detail = sampleDetail({
      package: {
        ...sampleDetail().package,
        url: "https://attacker.example/never-request-this.zip",
        sha256,
        size: body.byteLength,
      },
    })
    const reader = createCatalogPackageReader(store.client, publicPrefix)

    expect(await reader.read(detail)).toEqual({ body, sha256, size: body.byteLength })
    expect(store.reads).toEqual([
      `public-market/packages/${sha256}.zip`,
      `public-market/packages/${sha256}.zip`,
    ])
    expect(store.reads.join("\n")).not.toContain("attacker.example")
  })

  test("reads community packages from their trusted identity key", async () => {
    const store = memoryObjectStore({ body })
    const detail = sampleDetail({
      source: "community",
      package: {
        ...sampleDetail().package,
        sha256,
        size: body.byteLength,
      },
    })
    const reader = createCatalogPackageReader(store.client, publicPrefix)

    await reader.read(detail)
    expect(store.reads).toEqual([
      `public-market/packages/community/code-review/1.0.0/${sha256}.zip`,
      `public-market/packages/community/code-review/1.0.0/${sha256}.zip`,
    ])
  })

  test("rejects a declared package above the catalog size limit", async () => {
    const reader = createCatalogPackageReader(memoryObjectStore({ body }).client, publicPrefix)

    await expect(reader.read(detailWithSize(MAX_CATALOG_PACKAGE_SIZE + 1))).rejects.toMatchObject({
      kind: "too-large",
      phase: "declared-size",
    } satisfies Partial<CatalogPackageReadError>)
  })

  test("rejects a stored package above the catalog size limit", async () => {
    const reader = createCatalogPackageReader(
      memoryObjectStore({ body, headSize: MAX_CATALOG_PACKAGE_SIZE + 1 }).client,
      publicPrefix,
    )

    await expect(reader.read(detail())).rejects.toMatchObject({
      kind: "too-large",
      phase: "stored-size",
    } satisfies Partial<CatalogPackageReadError>)
  })

  test("rejects a package missing from object metadata", async () => {
    const reader = createCatalogPackageReader(memoryObjectStore({ body, missingHead: true }).client, publicPrefix)

    await expect(reader.read(detail())).rejects.toMatchObject({
      kind: "unavailable",
      phase: "head",
    } satisfies Partial<CatalogPackageReadError>)
  })

  test("rejects a package missing from object storage", async () => {
    const reader = createCatalogPackageReader(memoryObjectStore({ body, missingGet: true }).client, publicPrefix)

    await expect(reader.read(detail())).rejects.toMatchObject({
      kind: "unavailable",
      phase: "get",
    } satisfies Partial<CatalogPackageReadError>)
  })

  test("rejects a stored size that differs from the catalog detail", async () => {
    const reader = createCatalogPackageReader(memoryObjectStore({ body, headSize: body.byteLength + 1 }).client, publicPrefix)

    await expect(reader.read(detail())).rejects.toMatchObject({
      kind: "unavailable",
      phase: "stored-size",
    } satisfies Partial<CatalogPackageReadError>)
  })

  test("rejects a downloaded body that differs from object metadata", async () => {
    const reader = createCatalogPackageReader(
      memoryObjectStore({ body: new Uint8Array([...body, 0]), headSize: body.byteLength }).client,
      publicPrefix,
    )

    await expect(reader.read(detail())).rejects.toMatchObject({
      kind: "unavailable",
      phase: "body-size",
    } satisfies Partial<CatalogPackageReadError>)
  })

  test("rejects a downloaded body with a different SHA-256", async () => {
    const reader = createCatalogPackageReader(
      memoryObjectStore({ body: body.map((value, index) => (index === 0 ? value ^ 1 : value)), headSize: body.byteLength })
        .client,
      publicPrefix,
    )

    await expect(reader.read(detail())).rejects.toMatchObject({
      kind: "unavailable",
      phase: "sha256",
    } satisfies Partial<CatalogPackageReadError>)
  })
})

function detail() {
  return sampleDetail({
    package: {
      ...sampleDetail().package,
      sha256,
      size: body.byteLength,
    },
  })
}

function detailWithSize(size: number) {
  return sampleDetail({
    package: {
      ...sampleDetail().package,
      sha256,
      size,
    },
  })
}

function memoryObjectStore(options: {
  body: Uint8Array
  headSize?: number
  missingHead?: boolean
  missingGet?: boolean
}) {
  const reads: string[] = []
  const client: ObjectStore = {
    async put() {},
    async get(key) {
      reads.push(key)
      if (options.missingGet) throw new Error("missing object")
      return options.body
    },
    async head(key) {
      reads.push(key)
      if (options.missingHead) throw new Error("missing object")
      return { size: options.headSize ?? options.body.byteLength }
    },
  }
  return { client, reads }
}
