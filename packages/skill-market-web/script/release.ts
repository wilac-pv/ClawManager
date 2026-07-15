import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { join } from "node:path"

export type WebReleaseStore = {
  put: (key: string, body: string | Uint8Array, contentType: string, cacheControl: string) => Promise<void>
  head: (key: string) => Promise<{ size: number }>
}

export async function publishWebRelease(
  store: WebReleaseStore,
  options: {
    directory: string
    prefix: string
    createdAt?: string
    publicBasePath?: string
  },
) {
  const prefix = normalizePrefix(options.prefix)
  const paths = (
    await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: options.directory, onlyFiles: true }))
  ).toSorted()
  if (!paths.includes("index.html")) throw new Error("Skill market dist must contain index.html")
  const files = await Promise.all(
    paths.map(async (path) => {
      const body = await Bun.file(join(options.directory, path)).bytes()
      return {
        path,
        body,
        sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
        size: body.byteLength,
        contentType: contentType(path),
        cacheControl: path.endsWith(".html") ? "public, max-age=60" : "public, max-age=31536000, immutable",
      }
    }),
  )
  const release = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(files.map(({ path, sha256, size }) => ({ path, sha256, size }))))
    .digest("hex")
    .slice(0, 16)
  const releaseRoot = `${prefix}/${release}`
  const createdAt = options.createdAt ?? new Date().toISOString()
  const manifest = {
    release,
    createdAt,
    basePath: options.publicBasePath ?? "/ai-coding/ruying-code/skill-market/",
    entry: `${releaseRoot}/index.html`,
    fallback: `${releaseRoot}/index.html`,
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  }
  const manifestBody = JSON.stringify(manifest)
  const uploads = [
    ...files.map((file) => ({
      key: `${releaseRoot}/${file.path}`,
      body: file.body,
      contentType: file.contentType,
      cacheControl: file.cacheControl,
      size: file.size,
    })),
    {
      key: `${releaseRoot}/manifest.json`,
      body: manifestBody,
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
      size: new TextEncoder().encode(manifestBody).byteLength,
    },
  ]

  await Promise.all(
    uploads.map((upload) => store.put(upload.key, upload.body, upload.contentType, upload.cacheControl)),
  )
  const verified = await Promise.all(
    uploads.map(async (upload) => ({ upload, metadata: await store.head(upload.key) })),
  )
  verified.forEach(({ upload, metadata }) => {
    if (metadata.size !== upload.size) throw new Error(`OSS object size mismatch: ${upload.key}`)
  })
  const pointerKey = `${prefix}/current.json`
  await store.put(
    pointerKey,
    JSON.stringify({
      release,
      createdAt,
      entry: manifest.entry,
      fallback: manifest.fallback,
      manifest: `${releaseRoot}/manifest.json`,
    }),
    "application/json; charset=utf-8",
    "public, max-age=60",
  )
  return { release, pointerKey, manifestKey: `${releaseRoot}/manifest.json` }
}

export async function rollbackWebRelease(
  store: WebReleaseStore,
  options: {
    release: string
    prefix: string
    createdAt?: string
  },
) {
  if (!/^[a-f0-9]{16}$/.test(options.release)) throw new Error("Skill market Web release is invalid")
  const prefix = normalizePrefix(options.prefix)
  const releaseRoot = `${prefix}/${options.release}`
  const manifestKey = `${releaseRoot}/manifest.json`
  const verified = await Promise.all([store.head(manifestKey), store.head(`${releaseRoot}/index.html`)])
  if (verified.some((metadata) => metadata.size === 0)) throw new Error("Skill market Web release is incomplete")
  const pointerKey = `${prefix}/current.json`
  await store.put(
    pointerKey,
    JSON.stringify({
      release: options.release,
      createdAt: options.createdAt ?? new Date().toISOString(),
      entry: `${releaseRoot}/index.html`,
      fallback: `${releaseRoot}/index.html`,
      manifest: manifestKey,
    }),
    "application/json; charset=utf-8",
    "public, max-age=60",
  )
  return { release: options.release, pointerKey, manifestKey }
}

function makeS3Store(config: { endpoint: string; region: string; bucket: string }) {
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true })
  return {
    async put(key, body, contentType, cacheControl) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
        }),
      )
    },
    async head(key) {
      const output = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
      if (output.ContentLength === undefined) throw new Error(`OSS object has no content length: ${key}`)
      return { size: output.ContentLength }
    },
  } satisfies WebReleaseStore
}

function normalizePrefix(prefix: string) {
  const value = prefix.replace(/^\/+|\/+$/g, "")
  if (!value || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("OSS prefix is invalid")
  return value
}

function contentType(path: string) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8"
  if (path.endsWith(".css")) return "text/css; charset=utf-8"
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8"
  if (path.endsWith(".json") || path.endsWith(".map")) return "application/json; charset=utf-8"
  if (path.endsWith(".svg")) return "image/svg+xml"
  if (path.endsWith(".png")) return "image/png"
  if (path.endsWith(".ico")) return "image/x-icon"
  if (path.endsWith(".woff2")) return "font/woff2"
  return "application/octet-stream"
}

function requireHttpsUrl(name: string, value: string | undefined) {
  if (!value || !URL.canParse(value)) throw new Error(`${name} must be an HTTPS URL`)
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${name} must be an HTTPS URL`)
  return url.href
}

if (import.meta.main) {
  const endpoint = requireHttpsUrl("SKILL_MARKET_OSS_ENDPOINT", process.env.SKILL_MARKET_OSS_ENDPOINT)
  const store = makeS3Store({
    endpoint,
    region: process.env.SKILL_MARKET_OSS_REGION ?? "cn-baoding",
    bucket: process.env.SKILL_MARKET_OSS_BUCKET ?? "app-platform",
  })
  const prefix = process.env.SKILL_MARKET_WEB_OSS_PREFIX ?? "ai-coding/ruying-code/skill-market/web"
  const rollback = process.env.SKILL_MARKET_WEB_ROLLBACK_RELEASE
  const result = rollback
    ? await rollbackWebRelease(store, { release: rollback, prefix })
    : await publishWebRelease(store, {
        directory: join(import.meta.dir, "../dist"),
        prefix,
        publicBasePath: process.env.SKILL_MARKET_WEB_BASE_PATH ?? "/ai-coding/ruying-code/skill-market/",
      })
  console.info(
    `${rollback ? "Rolled back" : "Published"} Skill market Web release ${result.release} (${result.pointerKey})`,
  )
}
