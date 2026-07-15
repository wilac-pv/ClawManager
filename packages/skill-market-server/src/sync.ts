import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Option, Schema } from "effect"
import matter from "gray-matter"
import { inflateRawSync } from "node:zlib"
import { type CatalogSnapshot, key, mergeCatalog } from "./catalog"
import { type SkillMarketConfig, loadConfig } from "./config"
import { decodeEnterpriseIndex } from "./enterprise"
import { type ObjectStore, loadCurrentSnapshot, makeS3ObjectStore, publishSnapshot } from "./oss"
import { type SkillHubRecord, loadSkillHub } from "./skillhub"

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type MaterializeOptions = {
  readonly fetcher: Fetcher
  readonly store: ObjectStore
  readonly allowedHosts: ReadonlySet<string>
  readonly ossPrefix: string
  readonly publicBaseUrl: string
}

type SyncOptions = {
  readonly fetcher: Fetcher
  readonly store: ObjectStore
  readonly config: SkillMarketConfig
  readonly now?: () => Date
}

const compressedLimit = 50 * 1024 * 1024
const expandedLimit = 100 * 1024 * 1024
const fileLimit = 1_000
const SkillHubArchiveMetadata = Schema.Struct({ slug: Schema.String, version: Schema.String })

const SyncState = Schema.Struct({
  lastSkillhubAt: SkillMarket.Timestamp.pipe(Schema.optional),
  enterpriseEtag: Schema.String.pipe(Schema.optional),
  enterpriseIndex: SkillMarket.EnterpriseIndex.pipe(Schema.optional),
})
type SyncState = typeof SyncState.Type

export async function materializeSkillHubRecord(record: SkillHubRecord, options: MaterializeOptions) {
  const downloaded = await download(options.fetcher, record.downloadUrl, options.allowedHosts, compressedLimit)
  const archive = verifySkillArchive(downloaded.body)
  assertManifest(record.files, archive.files)
  assertSkillHubMetadata(record, archive.metadata)
  const packageKey = `${normalizePrefix(options.ossPrefix)}/packages/${downloaded.sha256}.zip`
  await options.store.put(packageKey, downloaded.body, "application/zip", "public, max-age=31536000, immutable")
  const iconUrl = record.iconUrl ? await mirrorIcon(record.iconUrl, options).catch(() => undefined) : undefined
  const publishedAt =
    record.versions.find((version) => version.version === record.version)?.publishedAt ?? record.updatedAt
  return Schema.decodeUnknownPromise(SkillMarket.Detail)({
    id: archive.name,
    source: "skillhub",
    sourceUrl: record.sourceUrl,
    name: record.name,
    description: archive.description,
    ...(iconUrl ? { iconUrl } : {}),
    categories: record.categories,
    tags: record.tags,
    ...(record.slug === archive.name ? {} : { aliases: [record.slug] }),
    requiresApiKey: record.requiresApiKey,
    risk: record.risk,
    version: record.version,
    updatedAt: record.updatedAt,
    downloads: record.downloads,
    favorites: record.favorites,
    score: record.score,
    featured: false,
    enterprise: false,
    delisted: false,
    readme: archive.readme,
    ...(archive.license ? { license: archive.license } : {}),
    author: record.author,
    versions: [{ version: record.version, publishedAt, sha256: downloaded.sha256, size: downloaded.body.byteLength }],
    securityReports: record.securityReports,
    ...(record.riskReason ? { riskReason: record.riskReason } : {}),
    package: {
      url: publicUrl(options.publicBaseUrl, `packages/${downloaded.sha256}.zip`),
      sha256: downloaded.sha256,
      size: downloaded.body.byteLength,
      files: archive.files,
    },
    publicDetailUrl: record.publicDetailUrl,
  })
}

export async function materializeSkillHubRecords(
  records: readonly SkillHubRecord[],
  options: MaterializeOptions,
  previous: ReadonlyMap<string, SkillMarket.Detail> = new Map(),
) {
  const details = await materializeInBatches(records, (record) =>
    materializeSkillHubRecord(record, options).then(
      (detail) => detail,
      (error: unknown) => {
        console.warn(
          JSON.stringify({
            skill_market_materialize_error: {
              source: "skillhub",
              id: record.slug,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        )
        return previous.get(record.slug)
      },
    ),
  )
  return details.filter((detail): detail is SkillMarket.Detail => detail !== undefined)
}

export function verifySkillArchive(body: Uint8Array) {
  if (body.byteLength > compressedLimit) throw new Error("skill archive exceeds compressed size limit")
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const endOffset = findEndRecord(view)
  const entries = view.getUint16(endOffset + 10, true)
  const centralSize = view.getUint32(endOffset + 12, true)
  const centralOffset = view.getUint32(endOffset + 16, true)
  const endCommentLength = view.getUint16(endOffset + 20, true)
  if (endOffset + 22 + endCommentLength !== body.byteLength) throw new Error("invalid ZIP end record")
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    throw new Error("ZIP64 archives are not supported")
  if (entries > fileLimit) throw new Error("skill archive exceeds file limit")
  requireRange(body, centralOffset, centralSize)
  if (centralOffset + centralSize !== endOffset) throw new Error("ZIP central directory offset mismatch")

  const files: Array<{ path: string; sha256: string; size: number }> = []
  const names = new Set<string>()
  let position = centralOffset
  let expanded = 0
  let skill: Uint8Array | undefined
  let archiveMetadata: typeof SkillHubArchiveMetadata.Type | undefined
  for (let index = 0; index < entries; index++) {
    requireRange(body, position, 46)
    if (view.getUint32(position, true) !== 0x02014b50) throw new Error("invalid ZIP central directory")
    const flags = view.getUint16(position + 8, true)
    const method = view.getUint16(position + 10, true)
    const compressedSize = view.getUint32(position + 20, true)
    const size = view.getUint32(position + 24, true)
    const nameLength = view.getUint16(position + 28, true)
    const extraLength = view.getUint16(position + 30, true)
    const commentLength = view.getUint16(position + 32, true)
    const externalAttributes = view.getUint32(position + 38, true)
    const localOffset = view.getUint32(position + 42, true)
    requireRange(body, position + 46, nameLength + extraLength + commentLength)
    const path = new TextDecoder("utf-8", { fatal: true }).decode(
      body.subarray(position + 46, position + 46 + nameLength),
    )
    assertZipPath(path)
    assertExtraFields(body.subarray(position + 46 + nameLength, position + 46 + nameLength + extraLength))
    if (flags & 1) throw new Error("encrypted ZIP entries are not supported")
    if (method !== 0 && method !== 8) throw new Error(`unsupported ZIP compression method: ${method}`)
    const mode = (externalAttributes >>> 16) & 0xffff
    const kind = mode & 0o170000
    if (kind === 0o120000) throw new Error(`ZIP symlink is not allowed: ${path}`)
    if (kind !== 0 && kind !== 0o040000 && kind !== 0o100000) throw new Error(`unsupported ZIP entry type: ${path}`)
    if (names.has(path)) throw new Error(`duplicate ZIP path: ${path}`)
    names.add(path)
    if (path.endsWith("/")) {
      if (size !== 0) throw new Error(`ZIP directory contains data: ${path}`)
      position += 46 + nameLength + extraLength + commentLength
      continue
    }
    expanded += size
    if (expanded > expandedLimit) throw new Error("skill archive exceeds expanded size limit")
    const content = readEntry(body, view, localOffset, flags, method, compressedSize, size, path)
    const file = { path, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"), size }
    files.push(file)
    if (path === "SKILL.md") skill = content
    if (path === "_meta.json") archiveMetadata = parseSkillHubMetadata(content)
    position += 46 + nameLength + extraLength + commentLength
  }
  if (position !== centralOffset + centralSize) throw new Error("ZIP central directory size mismatch")
  if (!skill) throw new Error("skill archive must contain root SKILL.md")
  const markdown = matter(new TextDecoder("utf-8", { fatal: true }).decode(skill))
  const metadata: unknown = markdown.data
  const name = metadataString(metadata, "name")
  const description = metadataString(metadata, "description")
  const license = optionalMetadataString(metadata, "license")
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) throw new Error("SKILL.md name is not a safe skill id")
  return {
    name,
    description,
    ...(license ? { license } : {}),
    readme: markdown.content,
    files: files.toSorted((a, b) => a.path.localeCompare(b.path)),
    metadata: archiveMetadata,
  }
}

export async function synchronize(options: SyncOptions) {
  const started = performance.now()
  const now = (options.now ?? (() => new Date()))()
  const state = await loadState(options.store, options.config.ossPrefix)
  const previous = await settled(loadCurrentSnapshot(options.store, { prefix: options.config.ossPrefix }))
  const previousSkillhub = new Map<string, SkillMarket.Detail>(
    previous.ok
      ? sourceDetails(previous.value, "skillhub").flatMap((detail) =>
          [detail.id, ...(detail.aliases ?? [])].map((id) => [id, detail] as const),
        )
      : [],
  )
  const canReuseSkillhub =
    previous.ok &&
    state.lastSkillhubAt !== undefined &&
    now.getTime() - Date.parse(state.lastSkillhubAt) < 10 * 60 * 1_000
  const skillhub = canReuseSkillhub
    ? ({
        ok: true,
        value: { value: previous.value.items.length, details: sourceDetails(previous.value, "skillhub"), reused: true },
      } as const)
    : await settled(
        loadSkillHub(options.fetcher, options.config.skillhubBaseUrl, undefined, options.config.skillhubLimit).then(
          async (records) => ({
            value: records.length,
            details: await materializeSkillHubRecords(records, materializeOptions(options), previousSkillhub),
            reused: false as const,
          }),
        ),
      )
  const enterprise = await settled(
    loadEnterpriseConditional(options, state).then(async (value) => ({
      ...value,
      details: await materializeInBatches(
        value.index.skills.filter((entry) => entry.source === "enterprise"),
        (entry) => materializeEnterpriseRecord(entry, value.index.updatedAt, materializeOptions(options)),
      ),
    })),
  )

  if (!skillhub.ok && !enterprise.ok && !previous.ok)
    throw new Error("all skill market sources failed and no prior snapshot exists")
  if (!skillhub.ok && !enterprise.ok && previous.ok) {
    emitMetrics(performance.now() - started, previous.value, false, false)
    return { snapshot: previous.value, published: false }
  }

  const enterpriseDetails = enterprise.ok
    ? enterprise.value.details
    : previous.ok
      ? sourceDetails(previous.value, "enterprise")
      : []
  const skillhubDetails = skillhub.ok
    ? skillhub.value.details
    : previous.ok
      ? sourceDetails(previous.value, "skillhub")
      : []
  const preservedSkillhub =
    enterprise.ok || !previous.ok
      ? skillhubDetails
      : skillhubDetails.map((detail) =>
          preserveEnterprise(detail, previous.value.details.get(key(detail.source, detail.id))),
        )
  const index = enterprise.ok ? enterprise.value.index : emptyEnterpriseIndex(now)
  const sourceStatus: SkillMarket.SourceStatus = {
    skillhub: skillhub.ok ? "fresh" : skillhubDetails.length ? "stale" : "unavailable",
    enterprise:
      enterprise.ok || (previous.ok && previous.value.items.some((item) => item.enterprise))
        ? enterprise.ok
          ? "fresh"
          : "stale"
        : "unavailable",
    community: "unavailable",
  }
  const snapshot = mergeCatalog(dedupe([...preservedSkillhub, ...enterpriseDetails]), index, sourceStatus)
  await publishSnapshot(options.store, { prefix: options.config.ossPrefix }, snapshot)
  const nextState: SyncState = {
    lastSkillhubAt: skillhub.ok && !skillhub.value.reused ? now.toISOString() : state.lastSkillhubAt,
    enterpriseEtag: enterprise.ok ? enterprise.value.etag : state.enterpriseEtag,
    enterpriseIndex: enterprise.ok ? enterprise.value.index : state.enterpriseIndex,
  }
  await saveState(options.store, options.config.ossPrefix, nextState).catch(() => undefined)
  emitMetrics(performance.now() - started, snapshot, skillhub.ok, enterprise.ok)
  return { snapshot, published: true }
}

async function materializeEnterpriseRecord(
  entry: SkillMarket.EnterpriseIndex["skills"][number],
  updatedAt: string,
  options: MaterializeOptions,
) {
  if (!entry.package) throw new Error(`enterprise skill has no package: ${entry.id}`)
  const downloaded = await download(
    options.fetcher,
    entry.package.url,
    options.allowedHosts,
    compressedLimit,
    entry.package.sha256,
  )
  const archive = verifySkillArchive(downloaded.body)
  const packageKey = `${normalizePrefix(options.ossPrefix)}/packages/${downloaded.sha256}.zip`
  await options.store.put(packageKey, downloaded.body, "application/zip", "public, max-age=31536000, immutable")
  return Schema.decodeUnknownPromise(SkillMarket.Detail)({
    id: archive.name,
    source: "enterprise",
    sourceUrl: entry.package.url,
    name: entry.name,
    description: archive.description,
    categories: [entry.category],
    tags: [],
    ...(archive.name === entry.id ? {} : { aliases: [entry.id] }),
    requiresApiKey: false,
    risk: entry.risk ?? "unknown",
    version: entry.version,
    updatedAt,
    downloads: 0,
    favorites: 0,
    score: entry.featured ? 100 : 0,
    featured: entry.featured,
    enterprise: true,
    delisted: entry.delisted ?? false,
    readme: archive.readme,
    ...((entry.license ?? archive.license) ? { license: entry.license ?? archive.license } : {}),
    author: { name: "Ruying Code" },
    versions: [
      { version: entry.version, publishedAt: updatedAt, sha256: downloaded.sha256, size: downloaded.body.byteLength },
    ],
    securityReports: [],
    ...(entry.riskReason ? { riskReason: entry.riskReason } : {}),
    package: {
      url: publicUrl(options.publicBaseUrl, `packages/${downloaded.sha256}.zip`),
      sha256: downloaded.sha256,
      size: downloaded.body.byteLength,
      files: archive.files,
    },
    publicDetailUrl: publicUrl(options.publicBaseUrl, `skills/enterprise/${encodeURIComponent(archive.name)}`),
  })
}

async function loadEnterpriseConditional(options: SyncOptions, state: SyncState) {
  const response = await fetchFollowingRedirects(
    options.fetcher,
    options.config.enterpriseIndexUrl,
    options.config.allowedHosts,
    state.enterpriseEtag
      ? { "if-none-match": state.enterpriseEtag, accept: "application/json" }
      : { accept: "application/json" },
  )
  if (response.status === 304) {
    if (!state.enterpriseIndex) throw new Error("enterprise index returned 304 without a cached index")
    return { index: state.enterpriseIndex, etag: state.enterpriseEtag }
  }
  if (!response.ok) throw new Error(`enterprise index request failed with ${response.status}`)
  return {
    index: await decodeEnterpriseIndex(await response.json(), options.config.allowedHosts),
    etag: response.headers.get("etag") ?? undefined,
  }
}

async function mirrorIcon(input: string, options: MaterializeOptions) {
  const response = await fetchFollowingRedirects(options.fetcher, input, options.allowedHosts, { accept: "image/*" })
  if (!response.ok) throw new Error(`icon request failed with ${response.status}`)
  const downloaded = await readLimited(response, 2 * 1024 * 1024)
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" }[
    contentType ?? ""
  ]
  if (!extension) throw new Error("icon content type is not allowed")
  const objectKey = `${normalizePrefix(options.ossPrefix)}/icons/${downloaded.sha256}.${extension}`
  await options.store.put(objectKey, downloaded.body, contentType!, "public, max-age=31536000, immutable")
  return publicUrl(options.publicBaseUrl, `icons/${downloaded.sha256}.${extension}`)
}

async function download(
  fetcher: Fetcher,
  input: string,
  allowedHosts: ReadonlySet<string>,
  limit: number,
  expectedSha256?: string,
) {
  const response = await fetchFollowingRedirects(fetcher, input, allowedHosts, {
    accept: "application/zip, application/octet-stream",
  })
  if (!response.ok) throw new Error(`package request failed with ${response.status}`)
  const result = await readLimited(response, limit)
  if (expectedSha256 && result.sha256 !== expectedSha256) throw new Error("package SHA-256 mismatch")
  return result
}

async function fetchFollowingRedirects(
  fetcher: Fetcher,
  input: string,
  allowedHosts: ReadonlySet<string>,
  headers: Record<string, string>,
  remaining = 5,
): Promise<Response> {
  assertAllowedUrl(input, allowedHosts)
  const response = await fetcher(input, { redirect: "manual", headers })
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (remaining === 0) throw new Error("too many redirects")
    const location = response.headers.get("location")
    if (!location) throw new Error("redirect response has no location")
    return fetchFollowingRedirects(fetcher, new URL(location, input).href, allowedHosts, headers, remaining - 1)
  }
  if (response.url) assertAllowedUrl(response.url, allowedHosts)
  return response
}

async function readLimited(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > limit) throw new Error("download exceeds size limit")
  if (!response.body) throw new Error("download response has no body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const hasher = new Bun.CryptoHasher("sha256")
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error("download exceeds size limit")
    }
    hasher.update(chunk.value)
    chunks.push(chunk.value)
  }
  const body = new Uint8Array(size)
  chunks.reduce((offset, chunk) => {
    body.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  return { body, sha256: hasher.digest("hex") }
}

function readEntry(
  body: Uint8Array,
  view: DataView,
  offset: number,
  flags: number,
  method: number,
  compressedSize: number,
  size: number,
  path: string,
) {
  requireRange(body, offset, 30)
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`invalid ZIP local header: ${path}`)
  if (view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method)
    throw new Error(`ZIP header mismatch: ${path}`)
  const nameLength = view.getUint16(offset + 26, true)
  const extraLength = view.getUint16(offset + 28, true)
  requireRange(body, offset + 30, nameLength + extraLength + compressedSize)
  const localPath = new TextDecoder("utf-8", { fatal: true }).decode(
    body.subarray(offset + 30, offset + 30 + nameLength),
  )
  if (localPath !== path) throw new Error(`ZIP local filename mismatch: ${path}`)
  assertExtraFields(body.subarray(offset + 30 + nameLength, offset + 30 + nameLength + extraLength))
  const start = offset + 30 + nameLength + extraLength
  const compressed = body.subarray(start, start + compressedSize)
  const content =
    method === 0
      ? compressed.slice()
      : new Uint8Array(inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1) }))
  if (content.byteLength !== size) throw new Error(`ZIP entry size mismatch: ${path}`)
  return content
}

function findEndRecord(view: DataView) {
  const start = Math.max(0, view.byteLength - 65_557)
  for (let offset = view.byteLength - 22; offset >= start; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }
  throw new Error("invalid ZIP end record")
}

function assertZipPath(path: string) {
  const parts = path.split("/")
  const directory = path.endsWith("/")
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    parts.some((part, index) => part === "." || part === ".." || (!part && (!directory || index !== parts.length - 1)))
  )
    throw new Error(`unsafe ZIP path: ${path}`)
}

function assertExtraFields(extra: Uint8Array) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
  let offset = 0
  while (offset < extra.byteLength) {
    if (offset + 4 > extra.byteLength) throw new Error("invalid ZIP extra field")
    const id = view.getUint16(offset, true)
    const size = view.getUint16(offset + 2, true)
    if (id === 1) throw new Error("ZIP64 archives are not supported")
    offset += 4 + size
    if (offset > extra.byteLength) throw new Error("invalid ZIP extra field")
  }
}

function assertManifest(
  expected: ReadonlyArray<{ readonly path: string; readonly sha256: string; readonly size: number }>,
  actual: ReadonlyArray<{ readonly path: string; readonly sha256: string; readonly size: number }>,
) {
  const files = new Map(actual.filter((file) => file.path !== "_meta.json").map((file) => [file.path, file]))
  if (files.size !== expected.length) throw new Error("SkillHub file manifest count mismatch")
  expected.forEach((file) => {
    const value = files.get(file.path)
    if (!value || value.sha256 !== file.sha256 || value.size !== file.size)
      throw new Error(`SkillHub file manifest mismatch: ${file.path}`)
  })
}

function assertSkillHubMetadata(record: SkillHubRecord, metadata: typeof SkillHubArchiveMetadata.Type | undefined) {
  if (!metadata) return
  if (metadata.slug !== record.slug || metadata.version !== record.version)
    throw new Error("SkillHub archive metadata mismatch")
}

function parseSkillHubMetadata(content: Uint8Array) {
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(
    new TextDecoder("utf-8", { fatal: true }).decode(content),
  )
  if (Option.isNone(json)) throw new Error("SkillHub archive metadata is invalid")
  const metadata = Schema.decodeUnknownOption(SkillHubArchiveMetadata)(json.value)
  if (Option.isNone(metadata)) throw new Error("SkillHub archive metadata is invalid")
  return metadata.value
}

function metadataString(input: unknown, field: string) {
  if (!input || typeof input !== "object") throw new Error("SKILL.md frontmatter is required")
  const value = Reflect.get(input, field)
  if (typeof value !== "string" || !value.trim()) throw new Error(`SKILL.md ${field} is required`)
  return value.trim()
}

function optionalMetadataString(input: unknown, field: string) {
  if (!input || typeof input !== "object") return undefined
  const value = Reflect.get(input, field)
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`SKILL.md ${field} must be a string`)
  return value.trim() || undefined
}

function requireRange(body: Uint8Array, offset: number, size: number) {
  if (offset < 0 || size < 0 || offset + size > body.byteLength) throw new Error("ZIP entry is out of bounds")
}

function assertAllowedUrl(input: string, allowedHosts: ReadonlySet<string>) {
  if (!URL.canParse(input)) throw new Error("download URL is invalid")
  const url = new URL(input)
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.has(url.hostname.toLocaleLowerCase()))
    throw new Error(`download URL host is not allowed: ${url.hostname}`)
}

function publicUrl(base: string, path: string) {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).href
}

function normalizePrefix(prefix: string) {
  const value = prefix.replace(/^\/+|\/+$/g, "")
  if (!value || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("OSS prefix is invalid")
  return value
}

function materializeOptions(options: SyncOptions): MaterializeOptions {
  return {
    fetcher: options.fetcher,
    store: options.store,
    allowedHosts: options.config.allowedHosts,
    ossPrefix: options.config.ossPrefix,
    publicBaseUrl: options.config.publicBaseUrl,
  }
}

async function materializeInBatches<Input, Output>(
  input: ReadonlyArray<Input>,
  materialize: (value: Input) => Promise<Output>,
) {
  const chunks = Array.from({ length: Math.ceil(input.length / 4) }, (_, index) =>
    input.slice(index * 4, index * 4 + 4),
  )
  const output: Output[] = []
  for (const chunk of chunks) output.push(...(await Promise.all(chunk.map(materialize))))
  return output
}

function sourceDetails(snapshot: CatalogSnapshot, source: SkillMarket.Source) {
  return Array.from(snapshot.details.values()).filter((detail) => detail.source === source)
}

function preserveEnterprise(detail: SkillMarket.Detail, previous: SkillMarket.Detail | undefined) {
  if (!previous?.enterprise) return detail
  const risk = riskRank(previous.risk) > riskRank(detail.risk) ? previous.risk : detail.risk
  return {
    ...detail,
    name: previous.name,
    description: previous.description,
    categories: previous.categories,
    featured: previous.featured,
    enterprise: true,
    delisted: previous.delisted,
    license: previous.license ?? detail.license,
    risk,
    riskReason: risk === previous.risk ? previous.riskReason : detail.riskReason,
  }
}

function dedupe(details: ReadonlyArray<SkillMarket.Detail>) {
  return Array.from(new Map(details.map((detail) => [key(detail.source, detail.id), detail])).values())
}

function emptyEnterpriseIndex(now: Date): SkillMarket.EnterpriseIndex {
  return { schemaVersion: 1, updatedAt: now.toISOString(), skills: [] }
}

function riskRank(risk: SkillMarket.Risk) {
  return { safe: 0, unknown: 1, warning: 2, danger: 3 }[risk]
}

async function loadState(store: ObjectStore, prefix: string): Promise<SyncState> {
  const value = await settled(store.get(`${normalizePrefix(prefix)}/sync-state.json`))
  if (!value.ok) return {}
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(new TextDecoder().decode(value.value))
  if (Option.isNone(json)) return {}
  return Option.getOrElse(Schema.decodeUnknownOption(SyncState)(json.value), () => ({}))
}

async function saveState(store: ObjectStore, prefix: string, state: SyncState) {
  await store.put(`${normalizePrefix(prefix)}/sync-state.json`, JSON.stringify(state), "application/json", "no-store")
}

async function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  )
}

function emitMetrics(duration: number, snapshot: CatalogSnapshot, skillhub: boolean, enterprise: boolean) {
  console.info(
    JSON.stringify({
      skill_market_sync_duration_ms: Math.round(duration),
      skill_market_source_success: { skillhub: Number(skillhub), enterprise: Number(enterprise) },
      skill_market_catalog_count: snapshot.items.length,
    }),
  )
}

async function production() {
  const config = loadConfig()
  const store = makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket })
  await synchronize({ fetcher: (input, init) => fetch(input, init), store, config })
}

if (import.meta.main) await production()
