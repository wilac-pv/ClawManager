import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Option, Schema } from "effect"
import matter from "gray-matter"
import { applyEnterprise, contentAddressDetail, createCatalogIndex, type CatalogSnapshot, key, mergeCatalog } from "./catalog"
import { listPublishedCommunity, materializePublishedCommunitySkill } from "./community"
import { type SkillMarketConfig, loadConfig } from "./config"
import type { MarketDatabase } from "./database"
import { openDatabase } from "./database"
import { decodeEnterpriseIndex } from "./enterprise"
import { emitMarketMetric } from "./metrics"
import { type ObjectStore, loadCatalogDetail, loadCatalogIndex, loadCatalogIndexOrMissingPointer, loadCurrentSnapshot, makeS3ObjectStore, publishSnapshot } from "./oss"
import type { Publisher } from "./publisher"
import { createPublisher, normalizeMirrorDetailKey } from "./publisher"
import { normalizeSkillHubArchive } from "./skillhub-archive"
import { type SkillHubRecord } from "./skillhub"
import { createSkillHubImportStore } from "./skillhub-import-store"
import { inspectZipArchive } from "./submission-archive"
import { createSubmissions } from "./submissions"
import { createWorker } from "./worker"

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
  readonly database?: MarketDatabase
  readonly publisher?: Publisher
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
  const archive = normalizeSkillHubArchive(downloaded.body, record)
  const packageKey = `${normalizePrefix(options.ossPrefix)}/packages/${archive.sha256}.zip`
  await options.store.put(packageKey, archive.body, "application/zip", "public, max-age=31536000, immutable")
  const iconUrl = record.iconUrl ? await mirrorIcon(record.iconUrl, options).catch(() => undefined) : undefined
  const publishedAt =
    record.versions.find((version) => version.version === record.version)?.publishedAt ?? record.updatedAt
  return Schema.decodeUnknownPromise(SkillMarket.Detail)({
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
    score: record.score,
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
      url: publicUrl(options.publicBaseUrl, `packages/${archive.sha256}.zip`),
      sha256: archive.sha256,
      size: archive.body.byteLength,
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
  const archive = inspectZipArchive(body, {
    compressed: compressedLimit,
    expanded: expandedLimit,
    files: fileLimit,
    ratio: Number.POSITIVE_INFINITY,
  })
  const markdown = matter(new TextDecoder("utf-8", { fatal: true }).decode(archive.skill.content))
  const metadata: unknown = markdown.data
  const name = metadataString(metadata, "name")
  const description = metadataString(metadata, "description")
  const license = optionalMetadataString(metadata, "license")
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) throw new Error("SKILL.md name is not a safe skill id")
  const archiveMetadata = archive.entries.find((entry) => entry.path === "_meta.json")
  return {
    name,
    description,
    ...(license ? { license } : {}),
    readme: markdown.content,
    files: archive.entries
      .map((entry) => ({ path: entry.path, sha256: entry.sha256, size: entry.size }))
      .toSorted((a, b) => a.path.localeCompare(b.path)),
    metadata: archiveMetadata ? parseSkillHubMetadata(archiveMetadata.content) : undefined,
  }
}

export async function synchronize(options: SyncOptions) {
  if (options.database && !options.publisher)
    throw new Error("community synchronization requires the shared catalog publisher")
  if (!options.publisher)
    return synchronizeUnlocked(options, (snapshot) =>
      publishSnapshot(options.store, { prefix: options.config.ossPrefix }, snapshot).then(() => undefined),
    )
  return synchronizeIndexed(options, options.publisher)
}

async function synchronizeIndexed(options: SyncOptions, publisher: Publisher) {
  const started = performance.now()
  const now = (options.now ?? (() => new Date()))()
  const state = await loadState(options.store, options.config.ossPrefix)
  await publisher.recover()
  await drainPublisher(publisher)
  const imports = options.database ? createSkillHubImportStore({ database: options.database }) : undefined
  const beforeMigration = await catalogIndexOrMissing(options.store, options.config.ossPrefix)
  if (imports && beforeMigration && Array.from(beforeMigration.details.values()).some((ref) => ref.sha256.length !== 64))
    await publisher.seedLegacySkillHub(imports, "sync-migration")
  const current = await catalogIndexOrMissing(options.store, options.config.ossPrefix)
  const base = current
    ? current
    : createCatalogIndex({
        entries: new Map(),
        sourceStatus: { skillhub: "unavailable", enterprise: "unavailable", community: "unavailable" },
      })
  const imported = imports?.progress()
  const mirrored = imports
    ? new Map(
      imports.mirroredEntries().flatMap((entry) =>
        [entry.summary.id, ...(entry.summary.aliases ?? [])].map((id) => [id, {
          ...entry,
          detailKey: normalizeMirrorDetailKey(entry.detailKey, entry.detailSha256, options.config.ossPrefix),
        }] as const),
      ),
    )
    : new Map()
  const enterprise = await settled(loadEnterpriseConditional(options, state))
  const changedDetails = new Map<string, SkillMarket.Detail>()
  const materialized = enterprise.ok && !enterprise.value.notModified
    ? await materializeInBatches(
      enterprise.value.index.skills.filter((entry) => entry.source === "enterprise"),
      async (entry) => {
        const present = base.items.find((summary) => summary.source === "enterprise" && (summary.id === entry.id || summary.aliases?.includes(entry.id)))
        if (present && enterpriseEntryUnchanged(entry, state.enterpriseIndex)) {
          return { summary: present, ref: base.details.get(key(present.source, present.id))! }
        }
        const detail = await materializeEnterpriseRecord(entry, enterprise.value.index.updatedAt, materializeOptions(options))
        changedDetails.set(key(detail.source, detail.id), detail)
        return contentAddressDetail(detail)
      },
      )
    : []
  const sourceStatus: SkillMarket.SourceStatus = {
    skillhub: imported?.sourceStatus ?? base.sourceStatus.skillhub,
    enterprise: enterprise.ok ? "fresh" : base.sourceStatus.enterprise === "unavailable" ? "unavailable" : "stale",
    community: options.database ? "fresh" : base.sourceStatus.community,
  }
  let snapshot: CatalogSnapshot | undefined
  await publisher.withCatalogLease("sync", async (publish) => {
    const latest = (await loadCatalogIndexOrMissingPointer(options.store, { prefix: options.config.ossPrefix })) ?? createCatalogIndex({
      entries: new Map(),
      sourceStatus: { skillhub: "unavailable", enterprise: "unavailable", community: "unavailable" },
    })
    const latestEntries = new Map(
      latest.items.map((summary) => [key(summary.source, summary.id), {
        summary,
        ref: latest.details.get(key(summary.source, summary.id))!,
      }] as const),
    )
    if (enterprise.ok && !enterprise.value.notModified) {
      Array.from(latestEntries.keys()).filter((entryKey) => entryKey.startsWith("enterprise:")).forEach((entryKey) => latestEntries.delete(entryKey))
      materialized.forEach((entry) => latestEntries.set(key(entry.summary.source, entry.summary.id), entry))
      const overrides = enterprise.value.index.skills.filter((entry) => entry.source !== "enterprise")
      const previousOverrides = state.enterpriseIndex?.skills.filter((entry) => entry.source !== "enterprise") ?? []
      const affected = new Map(
        [...overrides, ...previousOverrides].map((entry) => [key(entry.source, entry.referenceId ?? entry.id), entry]),
      )
      for (const [targetKey, previous] of affected) {
        const active = overrides.filter((entry) => key(entry.source, entry.referenceId ?? entry.id) === targetKey)
        if (active.length === 1 && enterpriseEntryUnchanged(active[0]!, state.enterpriseIndex)) continue
        const [source, targetID] = targetKey.split(":", 2) as [SkillMarket.Source, string]
        const target = latest.items.find((summary) =>
          summary.source === source && [summary.id, ...(summary.aliases ?? [])].includes(targetID),
        )
        if (!target) continue
        const authoritative = source === "skillhub" ? mirrored.get(targetID) : undefined
        const detail = authoritative
          ? await loadCatalogDetail(options.store, { prefix: options.config.ossPrefix }, { ...latest, details: new Map([...latest.details, [key(target.source, target.id), { key: authoritative.detailKey, sha256: authoritative.detailSha256 }]]) }, target.source, target.id)
          : source === "community" && options.database
            ? await materializePublishedCommunitySkill(options.database, { store: options.store, publicPrefix: options.config.ossPrefix, publicBaseUrl: options.config.publicBaseUrl, webBaseUrl: options.config.webBaseUrl }, target.id)
            : undefined
        if (!detail) continue
        const changed = active.toSorted((left, right) => left.id.localeCompare(right.id)).reduce(applyEnterprise, detail)
        const entry = contentAddressDetail(changed)
        latestEntries.set(key(changed.source, changed.id), entry)
        if (latest.details.get(key(changed.source, changed.id))?.sha256 !== entry.ref.sha256)
          changedDetails.set(key(changed.source, changed.id), changed)
      }
    }
    const index = createCatalogIndex({ entries: latestEntries, sourceStatus: { ...latest.sourceStatus, ...sourceStatus } })
    snapshot = { revision: index.revision, createdAt: index.createdAt, items: index.items, details: new Map(), facets: index.facets, sourceStatus: index.sourceStatus }
    await publish({ index, changedDetails })
  })
  await saveState(options.store, options.config.ossPrefix, {
    lastSkillhubAt: state.lastSkillhubAt,
    enterpriseEtag: enterprise.ok ? enterprise.value.etag : state.enterpriseEtag,
    enterpriseIndex: enterprise.ok ? enterprise.value.index : state.enterpriseIndex,
  }).catch(() => undefined)
  emitMetrics(performance.now() - started, snapshot!, true, enterprise.ok, Boolean(options.database))
  return { snapshot: snapshot!, published: true }
}

async function synchronizeUnlocked(options: SyncOptions, publish: (snapshot: CatalogSnapshot) => Promise<void>) {
  const started = performance.now()
  const now = (options.now ?? (() => new Date()))()
  const state = await loadState(options.store, options.config.ossPrefix)
  const previous = await settled(loadCurrentSnapshot(options.store, { prefix: options.config.ossPrefix }))
  const imported = options.database ? createSkillHubImportStore({ database: options.database }).progress() : undefined
  const skillhub = {
    ok: true,
    value: {
      value: imported?.mirrored ?? 0,
      details: previous.ok ? sourceDetails(previous.value, "skillhub") : [],
      reused: true as const,
      status: imported?.sourceStatus ?? (previous.ok ? "stale" : "unavailable"),
    },
  } as const
  const enterprise = await settled(
    loadEnterpriseConditional(options, state).then(async (value) => ({
      ...value,
      details: await materializeInBatches(
        value.index.skills.filter((entry) => entry.source === "enterprise"),
        (entry) => materializeEnterpriseRecord(entry, value.index.updatedAt, materializeOptions(options)),
      ),
    })),
  )
  const community = options.database
    ? await settled(
        listPublishedCommunity(options.database, {
          store: options.store,
          publicPrefix: options.config.ossPrefix,
          publicBaseUrl: options.config.publicBaseUrl,
          webBaseUrl: options.config.webBaseUrl,
        }),
      )
    : ({ ok: false, error: new Error("community database is unavailable") } as const)

  if (!skillhub.ok && !enterprise.ok && !community.ok && !previous.ok)
    throw new Error("all skill market sources failed and no prior snapshot exists")
  if (!skillhub.ok && !enterprise.ok && !community.ok && previous.ok) {
    emitMetrics(performance.now() - started, previous.value, false, false, false)
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
  const communityDetails = community.ok
    ? community.value
    : previous.ok
      ? sourceDetails(previous.value, "community")
      : []
  const preservedSkillhub =
    enterprise.ok || !previous.ok
      ? skillhubDetails
      : skillhubDetails.map((detail) =>
          preserveEnterprise(detail, previous.value.details.get(key(detail.source, detail.id))),
        )
  const index = enterprise.ok ? enterprise.value.index : emptyEnterpriseIndex(now)
  const sourceStatus: SkillMarket.SourceStatus = {
    skillhub: skillhub.value.status,
    enterprise:
      enterprise.ok || (previous.ok && previous.value.items.some((item) => item.enterprise))
        ? enterprise.ok
          ? "fresh"
          : "stale"
        : "unavailable",
    community: community.ok ? "fresh" : communityDetails.length ? "stale" : "unavailable",
  }
  const snapshot = mergeCatalog(
    dedupe([...preservedSkillhub, ...enterpriseDetails, ...communityDetails]),
    index,
    sourceStatus,
  )
  await publish(snapshot)
  const nextState: SyncState = {
    lastSkillhubAt: state.lastSkillhubAt,
    enterpriseEtag: enterprise.ok ? enterprise.value.etag : state.enterpriseEtag,
    enterpriseIndex: enterprise.ok ? enterprise.value.index : state.enterpriseIndex,
  }
  await saveState(options.store, options.config.ossPrefix, nextState).catch(() => undefined)
  emitMetrics(performance.now() - started, snapshot, skillhub.ok, enterprise.ok, community.ok)
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
    return { index: state.enterpriseIndex, etag: state.enterpriseEtag, notModified: true as const }
  }
  if (!response.ok) throw new Error(`enterprise index request failed with ${response.status}`)
  return {
    index: await decodeEnterpriseIndex(await response.json(), options.config.allowedHosts),
    etag: response.headers.get("etag") ?? undefined,
    notModified: false as const,
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

function enterpriseEntryUnchanged(
  entry: SkillMarket.EnterpriseIndex["skills"][number],
  previous: SkillMarket.EnterpriseIndex | undefined,
) {
  const matching = previous?.skills.find((candidate) => candidate.source === "enterprise" && candidate.id === entry.id)
  return matching !== undefined && JSON.stringify(matching) === JSON.stringify(entry)
}

async function catalogIndexOrMissing(store: ObjectStore, prefix: string) {
  return loadCatalogIndexOrMissingPointer(store, { prefix })
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

async function drainPublisher(publisher: Publisher): Promise<void> {
  const result = await publisher.runOne("sync-recovery")
  if (!result) return
  return drainPublisher(publisher)
}

function emitMetrics(
  duration: number,
  snapshot: CatalogSnapshot,
  skillhub: boolean,
  enterprise: boolean,
  community: boolean,
) {
  console.info(
    JSON.stringify({
      skill_market_sync_duration_ms: Math.round(duration),
      skill_market_source_success: {
        skillhub: Number(skillhub),
        enterprise: Number(enterprise),
        community: Number(community),
      },
      skill_market_catalog_count: snapshot.items.length,
    }),
  )
}

async function production() {
  const config = loadConfig()
  const store = makeS3ObjectStore({ endpoint: config.ossEndpoint, region: config.ossRegion, bucket: config.ossBucket })
  const database = await openDatabase({
    databasePath: config.databasePath,
    migrationBackupDirectory: config.migrationBackupDirectory,
    emit: emitMarketMetric,
  })
  const publisher = createPublisher({
    database,
    store,
    ossPrefix: config.ossPrefix,
    publicBaseUrl: config.publicBaseUrl,
    webBaseUrl: config.webBaseUrl,
  })
  const worker = createWorker({
    database,
    submissions: createSubmissions({ database }),
    store,
    publisher,
    sessionIdleMilliseconds: config.sessionIdleMilliseconds,
  })
  worker.cleanup()
  await worker.drain("sync-startup")
  await synchronize({ fetcher: (input, init) => fetch(input, init), store, config, database, publisher }).finally(() =>
    database.close(),
  )
}

if (import.meta.main) await production()
