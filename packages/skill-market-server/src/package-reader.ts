import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { communityPackageKey } from "./community"
import type { ObjectStore } from "./oss"

export const MAX_CATALOG_PACKAGE_SIZE = 50 * 1024 * 1024

type CatalogPackageReadPhase = "declared-size" | "head" | "stored-size" | "get" | "body-size" | "sha256"

export class CatalogPackageReadError extends Error {
  constructor(
    readonly kind: "too-large" | "unavailable",
    readonly phase: CatalogPackageReadPhase,
  ) {
    super(`catalog package ${kind} during ${phase}`)
    this.name = "CatalogPackageReadError"
  }
}

export function createCatalogPackageReader(store: ObjectStore, publicPrefix: string) {
  return {
    async read(detail: SkillMarket.Detail) {
      if (detail.package.size > MAX_CATALOG_PACKAGE_SIZE)
        throw new CatalogPackageReadError("too-large", "declared-size")
      const objectKey =
        detail.source === "community"
          ? communityPackageKey(publicPrefix, detail.id, detail.version, detail.package.sha256)
          : `${publicPrefix.replace(/^\/+|\/+$/g, "")}/packages/${detail.package.sha256}.zip`
      const metadata = await store.head(objectKey).catch(() => {
        throw new CatalogPackageReadError("unavailable", "head")
      })
      if (metadata.size > MAX_CATALOG_PACKAGE_SIZE)
        throw new CatalogPackageReadError("too-large", "stored-size")
      if (metadata.size !== detail.package.size)
        throw new CatalogPackageReadError("unavailable", "stored-size")
      const body = await store.get(objectKey).catch(() => {
        throw new CatalogPackageReadError("unavailable", "get")
      })
      if (body.byteLength !== metadata.size || body.byteLength !== detail.package.size)
        throw new CatalogPackageReadError("unavailable", "body-size")
      const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
      if (sha256 !== detail.package.sha256)
        throw new CatalogPackageReadError("unavailable", "sha256")
      return { body, sha256, size: body.byteLength }
    },
  }
}

export type CatalogPackageReader = ReturnType<typeof createCatalogPackageReader>
