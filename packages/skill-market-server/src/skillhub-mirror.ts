import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { AdaptivePoolError, createAdaptivePool } from "./adaptive-pool"
import type { PrivateObjectStore } from "./oss"
import type { ClaimedSkillHubItem, SkillHubImportStore } from "./skillhub-import-store"
import type { Fetcher, SkillHubRecord } from "./skillhub"
import { normalizeSkillHubArchive } from "./skillhub-archive"

const packageLimit = 50 * 1024 * 1024
const iconLimit = 2 * 1024 * 1024

export type MirrorFailure =
  | { readonly kind: "retry"; readonly code: "upstream" | "download" | "storage" | "rate_limited"; readonly retryAt: number }
  | { readonly kind: "reject"; readonly code: "upstream" | "download" | "validation" }

export interface SkillHubMirror {
  readonly runBatch: (workerID: string) => Promise<{ readonly mirrored: number; readonly retryWait: number; readonly rejected: number }>
}

export function createSkillHubMirror(options: {
  readonly imports: SkillHubImportStore
  readonly store: PrivateObjectStore
  readonly fetcher: Fetcher
  readonly loadRecord: (item: ClaimedSkillHubItem) => Promise<SkillHubRecord>
  readonly allowedHosts: ReadonlySet<string>
  readonly publicBaseUrl: string
  readonly objectPrefix?: string
  readonly metadataConcurrency?: number
  readonly packageConcurrency?: number
  readonly leaseMilliseconds?: number
  readonly memorySoftLimitMb?: number
  readonly now?: () => number
  readonly rssBytes?: () => number
  readonly random?: () => number
  readonly wait?: (milliseconds: number) => Promise<void>
}): SkillHubMirror {
  const now = options.now ?? Date.now
  const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const metadata = createAdaptivePool({
    minimum: 1,
    maximum: options.metadataConcurrency ?? 8,
    now,
    wait,
  })
  const packages = createAdaptivePool({
    minimum: 1,
    maximum: options.packageConcurrency ?? 6,
    now,
    wait,
  })
  const prefix = normalizePrefix(options.objectPrefix ?? "skillhub")
  const memoryLimit = (options.memorySoftLimitMb ?? Number.POSITIVE_INFINITY) * 1024 * 1024
  const rssBytes = options.rssBytes ?? (() => process.memoryUsage.rss())

  return {
    async runBatch(workerID) {
      if (rssBytes() > memoryLimit) return { mirrored: 0, retryWait: 0, rejected: 0 }
      const claimed = await options.imports.claim(workerID, packages.concurrency(), options.leaseMilliseconds ?? 5 * 60 * 1_000)
      const outcomes = await packages.map(claimed, async (item) => {
        const leaseMilliseconds = options.leaseMilliseconds ?? 5 * 60 * 1_000
        const heartbeat = setInterval(() => void options.imports.renew(workerID, item.slug, leaseMilliseconds).catch(() => undefined), Math.max(1, leaseMilliseconds / 2))
        const result = await mirrorClaim(item, options, metadata, packages, prefix, now, wait).finally(() => clearInterval(heartbeat))
        if ("detail" in result) return result
        if (result.kind === "reject") {
          return (await options.imports.reject(workerID, item.slug, result.code, result.code)) ? result : { kind: "fenced" as const }
        }
        return (await options.imports.retry(workerID, item.slug, result.code, result.code, result.retryAt))
          ? result
          : { kind: "fenced" as const }
      })
      let mirrored = 0
      let retryWait = 0
      let rejected = 0
      for (const outcome of outcomes) {
        if ("detail" in outcome) {
          if (await options.imports.complete(workerID, outcome.item.slug, outcome.detail)) mirrored += 1
          continue
        }
        if (outcome.kind === "fenced") continue
        if (outcome.kind === "retry") retryWait += 1
        if (outcome.kind === "reject") rejected += 1
      }
      return { mirrored, retryWait, rejected }
    },
  }
}

async function mirrorClaim(
  item: ClaimedSkillHubItem,
  options: Parameters<typeof createSkillHubMirror>[0],
  metadata: ReturnType<typeof createAdaptivePool>,
  packages: ReturnType<typeof createAdaptivePool>,
  prefix: string,
  now: () => number,
  wait: (milliseconds: number) => Promise<void>,
) {
  const record = await metadata.map([item], (value) => options.loadRecord(value)).then(
    ([value]) => value,
    (error: unknown) => metadataFailureFor(error, now, item.attempts, options.random),
  )
  if (isFailure(record)) return record
  if (record.securityReports.some((report) => report.verdict === "danger")) return reject("validation")

  const downloaded = await download(
    options.fetcher,
    record.downloadUrl,
    options.allowedHosts,
    packageLimit,
    now,
    wait,
    "application/zip, application/octet-stream",
    () => packages.throttle(),
  ).then(
    (value) => value,
    (error: unknown) => failureFor(error, now, item.attempts, options.random),
  )
  if (isFailure(downloaded)) return downloaded
  const archive = normalizeArchive(downloaded.body, record)
  if (isFailure(archive)) return archive

  const packageKey = `${prefix}/packages/${archive.sha256}.zip`
  const storedPackage = await storeIfMissing(options.store, packageKey, archive.body, "application/zip", archive.sha256)
  if (!storedPackage) return retry("storage", now(), undefined, item.attempts, options.random)
  const icon = record.iconUrl
    ? await mirrorIcon(record.iconUrl, options, prefix, now, wait).then(
        (value) => value,
        (error: unknown) => iconFailureFor(error, now, item.attempts, options.random),
      )
    : undefined
  if (isFailure(icon)) return icon
  const iconUrl = icon
  const detail = detailFor(record, archive, iconUrl, options.publicBaseUrl)
  const json = JSON.stringify(detail)
  const detailSha256 = sha256(new TextEncoder().encode(json))
  const detailKey = `details/${detailSha256}.json`
  const storedDetail = await storeIfMissing(options.store, `${prefix}/${detailKey}`, json, "application/json", detailSha256)
  if (!storedDetail) return retry("storage", now(), undefined, item.attempts, options.random)
  return {
    item,
    detail: {
      entry: { summary: summaryFor(detail), detailKey, detailSha256 },
      record,
      originalPackageSha256: downloaded.sha256,
      packageSha256: archive.sha256,
      packageSize: archive.body.byteLength,
      repairs: archive.repairs,
    },
  }
}

function normalizeArchive(body: Uint8Array, record: SkillHubRecord) {
  try {
    return normalizeSkillHubArchive(body, record)
  } catch {
    return reject("validation")
  }
}

async function download(
  fetcher: Fetcher,
  input: string,
  allowedHosts: ReadonlySet<string>,
  limit: number,
  now: () => number,
  wait: (milliseconds: number) => Promise<void>,
  accept: string,
  throttled?: () => void,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchRedirects(fetcher, input, allowedHosts, { accept })
      if (!response.ok) throw new AdaptivePoolError(`download failed with ${response.status}`, response.status, response.headers.get("retry-after"), response.status < 500 && response.status !== 429)
      return readLimited(response, limit)
    } catch (error) {
      if (!(error instanceof AdaptivePoolError) || error.permanent || attempt === 2) throw error
      if (error.status === 429 || error.status === undefined) throttled?.()
      await wait(retryDelay(error, attempt, now()))
    }
  }
  throw new Error("download retry loop exhausted")
}

async function mirrorIcon(
  input: string,
  options: Parameters<typeof createSkillHubMirror>[0],
  prefix: string,
  now: () => number,
  wait: (milliseconds: number) => Promise<void>,
) {
  const response = await download(options.fetcher, input, options.allowedHosts, iconLimit, now, wait, "image/*")
  const contentType = response.contentType?.split(";", 1)[0]
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" }[contentType ?? ""]
  if (!extension || !contentType) return undefined
  const key = `${prefix}/icons/${response.sha256}.${extension}`
  if (!(await storeIfMissing(options.store, key, response.body, contentType, response.sha256)))
    throw new AdaptivePoolError("icon storage failed")
  return publicUrl(options.publicBaseUrl, `icons/${response.sha256}.${extension}`)
}

async function fetchRedirects(
  fetcher: Fetcher,
  input: string,
  allowedHosts: ReadonlySet<string>,
  headers: Record<string, string>,
  remaining = 5,
): Promise<Response> {
  assertAllowedUrl(input, allowedHosts)
  let response: Response
  try {
    response = await fetcher(input, { redirect: "manual", headers })
  } catch (error) {
    throw new AdaptivePoolError(`network request failed: ${String(error)}`)
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (remaining === 0) throw new AdaptivePoolError("too many redirects", undefined, undefined, true)
    const location = response.headers.get("location")
    if (!location) throw new AdaptivePoolError("redirect response has no location", undefined, undefined, true)
    return fetchRedirects(fetcher, new URL(location, input).href, allowedHosts, headers, remaining - 1)
  }
  if (response.url) assertAllowedUrl(response.url, allowedHosts)
  return response
}

async function readLimited(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) throw new AdaptivePoolError("download exceeds size limit", undefined, undefined, true)
  if (!response.body) throw new AdaptivePoolError("download response has no body", undefined, undefined, true)
  const chunks: Uint8Array[] = []
  const reader = response.body.getReader()
  const hasher = new Bun.CryptoHasher("sha256")
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new AdaptivePoolError("download exceeds size limit", undefined, undefined, true)
    }
    chunks.push(chunk.value)
    hasher.update(chunk.value)
  }
  const body = new Uint8Array(size)
  chunks.reduce((offset, chunk) => {
    body.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  return { body, sha256: hasher.digest("hex"), contentType: response.headers.get("content-type") ?? undefined }
}

async function storeIfMissing(
  store: PrivateObjectStore,
  key: string,
  body: string | Uint8Array,
  contentType: string,
  expectedSha256: string,
) {
  try {
    const head = await store.head(key)
    const size = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength
    if (head.size === size && head.metadata?.sha256 === expectedSha256) return true
    if (head.size === size && head.metadata?.sha256 === undefined && sha256(await store.get(key)) === expectedSha256) return true
  } catch (error) {
    if (!isMissingObject(error)) return false
  }
  try {
    await store.put(key, body, contentType, "public, max-age=31536000, immutable", { sha256: expectedSha256 })
    return true
  } catch {
    return false
  }
}

function detailFor(
  record: SkillHubRecord,
  archive: ReturnType<typeof normalizeSkillHubArchive>,
  iconUrl: string | undefined,
  publicBaseUrl: string,
) {
  const publishedAt = record.versions.find((version) => version.version === record.version)?.publishedAt ?? record.updatedAt
  return Schema.decodeUnknownSync(SkillMarket.Detail)({
    id: archive.id,
    source: "skillhub",
    sourceUrl: record.sourceUrl,
    name: record.name,
    description: archive.description,
    ...(iconUrl ? { iconUrl } : {}),
    categories: record.categories,
    tags: record.tags,
    ...(record.slug === archive.id ? {} : { aliases: [record.slug] }),
    requiresApiKey: record.requiresApiKey,
    risk: record.risk,
    version: record.version,
    updatedAt: record.updatedAt,
    downloads: record.downloads,
    favorites: record.favorites,
    score: 0,
    featured: false,
    enterprise: false,
    delisted: false,
    readme: archive.readme,
    ...(archive.license ? { license: archive.license } : {}),
    author: record.author,
    versions: [{ version: record.version, publishedAt, sha256: archive.sha256, size: archive.body.byteLength }],
    securityReports: record.securityReports,
    ...(record.riskReason ? { riskReason: record.riskReason } : {}),
    package: {
      url: publicUrl(publicBaseUrl, `packages/${archive.sha256}.zip`),
      sha256: archive.sha256,
      size: archive.body.byteLength,
      files: archive.files,
    },
    publicDetailUrl: record.publicDetailUrl,
  })
}

function summaryFor(detail: SkillMarket.Detail) {
  return Schema.decodeUnknownSync(SkillMarket.Summary)(detail)
}

function failureFor(error: unknown, now: () => number, attempts: number, random: (() => number) | undefined): MirrorFailure {
  if (error instanceof AdaptivePoolError && error.permanent) return reject("download")
  if (error instanceof AdaptivePoolError && error.status === 429) return retry("rate_limited", now(), error.retryAfter, attempts, random)
  return retry("download", now(), undefined, attempts, random)
}

function metadataFailureFor(error: unknown, now: () => number, attempts: number, random: (() => number) | undefined): MirrorFailure {
  if (error instanceof AdaptivePoolError && !error.permanent) {
    if (error.status === 429) return retry("rate_limited", now(), error.retryAfter, attempts, random)
    return retry("upstream", now(), undefined, attempts, random)
  }
  return reject("upstream")
}

function iconFailureFor(error: unknown, now: () => number, attempts: number, random: (() => number) | undefined) {
  if (error instanceof AdaptivePoolError && error.permanent) return undefined
  return failureFor(error, now, attempts, random)
}

function retry(
  code: Extract<MirrorFailure, { readonly kind: "retry" }>["code"],
  timestamp: number,
  retryAfter: string | null | undefined,
  attempts: number,
  random: (() => number) | undefined,
): MirrorFailure {
  const exponential = Math.min(24 * 60 * 60 * 1_000, 1_000 * 2 ** Math.min(20, Math.max(0, attempts - 1)))
  const jittered = Math.round(exponential * (0.5 + (random ?? Math.random)()))
  return {
    kind: "retry",
    code,
    retryAt: timestamp + Math.min(24 * 60 * 60 * 1_000, Math.max(retryAfterMilliseconds(retryAfter, timestamp), jittered)),
  }
}

function reject(code: Extract<MirrorFailure, { readonly kind: "reject" }>["code"]): MirrorFailure {
  return { kind: "reject", code }
}

function isFailure(value: unknown): value is MirrorFailure {
  return typeof value === "object" && value !== null && "kind" in value
}

function retryDelay(error: AdaptivePoolError, attempt: number, timestamp: number) {
  return retryAfterMilliseconds(error.retryAfter, timestamp) || Math.min(30_000, 1_000 * 2 ** attempt)
}

function retryAfterMilliseconds(input: string | null | undefined, timestamp: number) {
  if (!input) return 1_000
  if (/^\d+$/.test(input)) return Number(input) * 1_000
  const parsed = Date.parse(input)
  return Number.isNaN(parsed) ? 1_000 : Math.max(0, parsed - timestamp)
}

function assertAllowedUrl(input: string, allowedHosts: ReadonlySet<string>) {
  if (!URL.canParse(input)) throw new AdaptivePoolError("download URL is invalid", undefined, undefined, true)
  const url = new URL(input)
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.has(url.hostname.toLocaleLowerCase()))
    throw new AdaptivePoolError(`download URL host is not allowed: ${url.hostname}`, undefined, undefined, true)
}

function isMissingObject(error: unknown) {
  if (!(error instanceof Error)) return false
  const status = Reflect.get(error, "$metadata")
  if (typeof status === "object" && status !== null && Reflect.get(status, "httpStatusCode") === 404) return true
  return error.name === "NotFound" || /(?:missing|not found)/i.test(error.message)
}

function sha256(body: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex")
}

function publicUrl(base: string, path: string) {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).href
}

function normalizePrefix(prefix: string) {
  const value = prefix.replace(/^\/+|\/+$/g, "")
  if (!value || value.split("/").some((segment) => !segment || segment === "." || segment === ".."))
    throw new Error("SkillHub object prefix is invalid")
  return value
}
