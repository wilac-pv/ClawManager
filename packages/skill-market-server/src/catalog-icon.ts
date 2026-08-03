import type { ObjectStore } from "./oss"

const iconLimit = 2 * 1024 * 1024
const contentTypes = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
} as const

export function createCatalogIconProxy(options: {
  readonly store: ObjectStore
  readonly publicPrefix: string
  readonly publicBaseUrl: string
}) {
  const publicBaseUrl = new URL(options.publicBaseUrl.endsWith("/") ? options.publicBaseUrl : `${options.publicBaseUrl}/`)
  const publicPrefix = options.publicPrefix.replace(/^\/+|\/+$/g, "")

  const resolve = (input: string) => {
    const url = new URL(input)
    if (url.origin !== publicBaseUrl.origin || url.search || url.hash || !url.pathname.startsWith(publicBaseUrl.pathname))
      return undefined
    const relative = url.pathname.slice(publicBaseUrl.pathname.length)
    const match = /^(?:icons|assets\/icons)\/([a-f0-9]{64})\.(png|jpg|webp|svg)$/.exec(relative)
    if (!match) return undefined
    const extension = match[2] as keyof typeof contentTypes
    return {
      key: publicPrefix ? `${publicPrefix}/${relative}` : relative,
      sha256: match[1]!,
      contentType: contentTypes[extension],
    }
  }

  return {
    async read(input: string | null) {
      if (!input) return undefined
      const icon = resolve(input)
      if (!icon) return undefined
      const metadata = await options.store.head(icon.key)
      if (metadata.size > iconLimit) throw new Error("catalog icon exceeds size limit")
      const body = await options.store.get(icon.key)
      if (body.byteLength !== metadata.size || body.byteLength > iconLimit)
        throw new Error("catalog icon size does not match stored metadata")
      if (new Bun.CryptoHasher("sha256").update(body).digest("hex") !== icon.sha256)
        throw new Error("catalog icon SHA-256 does not match its immutable URL")
      return { body, contentType: icon.contentType, sha256: icon.sha256 }
    },
  }
}

export type CatalogIconProxy = ReturnType<typeof createCatalogIconProxy>
