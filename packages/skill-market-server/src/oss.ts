import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { Readable } from "node:stream"
import { type CatalogDetailRef, type CatalogIndex, type CatalogSnapshot, key } from "./catalog"

export type ObjectStore = {
  readonly put: (
    key: string,
    body: string | Uint8Array,
    contentType: string,
    cacheControl: string,
    metadata?: Readonly<Record<string, string>>,
    request?: ObjectStoreRequest,
  ) => Promise<void>
  readonly putStream?: (
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentLength: number,
    contentType: string,
    cacheControl: string,
    metadata?: Readonly<Record<string, string>>,
    request?: ObjectStoreRequest,
  ) => Promise<void>
  readonly get: (key: string, request?: ObjectStoreRequest) => Promise<Uint8Array>
  readonly head: (key: string, request?: ObjectStoreRequest) => Promise<{
    size: number
    contentType?: string
    etag?: string
    metadata?: Readonly<Record<string, string>>
  }>
}

export interface PrivateObjectStore extends ObjectStore {
  readonly putPrivate: (
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
    metadata?: Readonly<Record<string, string>>,
    request?: ObjectStoreRequest,
  ) => Promise<void>
  readonly copy: (
    source: string,
    target: string,
    contentType?: string,
    metadata?: Readonly<Record<string, string>>,
    cacheControl?: string,
    request?: ObjectStoreRequest,
  ) => Promise<void>
  readonly delete: (key: string, request?: ObjectStoreRequest) => Promise<void>
}

export interface ObjectStoreRequest {
  readonly signal?: AbortSignal
}

export interface MaintenanceObjectStore extends PrivateObjectStore {
  readonly list: (prefix: string) => Promise<ReadonlyArray<{ readonly key: string; readonly lastModified: Date }>>
}

export type PublishConfig = { readonly prefix: string }

export function isExplicitMissingObjectError(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const value = error as { readonly name?: unknown; readonly $metadata?: { readonly httpStatusCode?: unknown } }
  return value.$metadata?.httpStatusCode === 404 || value.name === "NotFound" || value.name === "NoSuchKey"
}

export function isMissingObjectError(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const value = error as { readonly name?: unknown; readonly message?: unknown; readonly $metadata?: { readonly httpStatusCode?: unknown } }
  if (isExplicitMissingObjectError(error)) return true
  return typeof value.message === "string" && /^missing [a-zA-Z0-9._/-]+$/.test(value.message)
}

export function makeS3ObjectStore(config: {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
}) {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
  })
  return {
    async put(key, body, contentType, cacheControl, metadata = undefined, request = undefined) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
          Metadata: metadata,
        }),
        { abortSignal: request?.signal },
      )
    },
    async putStream(key, body, contentLength, contentType, cacheControl, metadata = undefined, request = undefined) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: Readable.from(body),
          ContentLength: contentLength,
          ContentType: contentType,
          CacheControl: cacheControl,
          Metadata: metadata,
        }),
        { abortSignal: request?.signal },
      )
    },
    async get(key, request = undefined) {
      const output = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: request?.signal })
      if (!output.Body) throw new Error(`OSS object has no body: ${key}`)
      return output.Body.transformToByteArray()
    },
    async head(key, request = undefined) {
      const output = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: request?.signal })
      if (output.ContentLength === undefined) throw new Error(`OSS object has no content length: ${key}`)
      return {
        size: output.ContentLength,
        ...(output.ContentType ? { contentType: output.ContentType } : {}),
        ...(output.ETag ? { etag: output.ETag } : {}),
        ...(output.Metadata ? { metadata: output.Metadata } : {}),
      }
    },
    async putPrivate(key, body, contentType, metadata = undefined, request = undefined) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: Readable.from(body),
          ContentType: contentType,
          CacheControl: "private, no-store",
          Metadata: metadata,
        }),
        { abortSignal: request?.signal },
      )
    },
    async copy(source, target, contentType = undefined, metadata = undefined, cacheControl = undefined, request = undefined) {
      await client.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          CopySource: encodeURIComponent(`${config.bucket}/${source}`),
          Key: target,
          CacheControl: cacheControl ?? "private, no-store",
          ContentType: contentType,
          Metadata: metadata,
          MetadataDirective: "REPLACE",
        }),
        { abortSignal: request?.signal },
      )
    },
    async delete(key, request = undefined) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: request?.signal })
    },
    async list(prefix) {
      return listObjects(client, config.bucket, prefix)
    },
  } satisfies MaintenanceObjectStore
}

async function listObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
  continuationToken?: string,
): Promise<ReadonlyArray<{ readonly key: string; readonly lastModified: Date }>> {
  const output = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
  )
  const objects = (output.Contents ?? []).flatMap((object) =>
    object.Key && object.LastModified ? [{ key: object.Key, lastModified: object.LastModified }] : [],
  )
  if (!output.IsTruncated || !output.NextContinuationToken) return objects
  return [...objects, ...(await listObjects(client, bucket, prefix, output.NextContinuationToken))]
}

const Pointer = Schema.Struct({ revision: Schema.String, createdAt: SkillMarket.Timestamp })
const CatalogObjectV1 = Schema.Struct({
  revision: Schema.String,
  createdAt: SkillMarket.Timestamp,
  items: Schema.Array(SkillMarket.Summary),
})
const CatalogItemV2 = Schema.Struct({
  summary: SkillMarket.Summary,
  detail: Schema.Struct({ key: Schema.String, sha256: SkillMarket.Sha256 }),
})
const CatalogObjectV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  revision: Schema.String,
  createdAt: SkillMarket.Timestamp,
  items: Schema.Array(CatalogItemV2),
})

export interface CatalogDeltaReplacement {
  readonly summary: SkillMarket.Summary
  readonly ref: CatalogDetailRef
  readonly expectedSha256: string
}

export interface CatalogDelta {
  readonly revision: string
  readonly createdAt: string
  readonly facets: SkillMarket.Facets
  readonly references: ReadonlyMap<string, CatalogDetailRef>
  readonly contentLength: number
  readonly body: () => AsyncIterable<Uint8Array>
}

export async function publishSnapshot(client: ObjectStore, config: PublishConfig, snapshot: CatalogSnapshot) {
  const index = indexFromSnapshot(snapshot)
  await publishCatalogIndex(client, config, index, snapshot.details)
  return { revision: snapshot.revision, pointerKey: keys(config, snapshot.revision).current }
}

export async function publishSnapshotObjects(client: ObjectStore, config: PublishConfig, snapshot: CatalogSnapshot) {
  const index = indexFromSnapshot(snapshot)
  await publishCatalogObjects(client, config, index, snapshot.details)
  return { revision: snapshot.revision }
}

export async function publishSnapshotPointer(client: ObjectStore, config: PublishConfig, snapshot: CatalogSnapshot) {
  return publishCatalogPointer(client, config, snapshot)
}

export async function publishCatalogIndex(
  client: ObjectStore,
  config: PublishConfig,
  index: CatalogIndex,
  changedDetails: ReadonlyMap<string, SkillMarket.Detail>,
) {
  await publishCatalogObjects(client, config, index, changedDetails)
  await publishCatalogPointer(client, config, index)
  return { revision: index.revision, pointerKey: keys(config, index.revision).current }
}

export async function publishCatalogIndexObjects(
  client: ObjectStore,
  config: PublishConfig,
  index: CatalogIndex,
  changedDetails: ReadonlyMap<string, SkillMarket.Detail>,
) {
  await publishCatalogObjects(client, config, index, changedDetails)
  return { revision: index.revision }
}

export async function publishCatalogIndexPointer(
  client: ObjectStore,
  config: PublishConfig,
  index: Pick<CatalogIndex, "revision" | "createdAt">,
) {
  return publishCatalogPointer(client, config, index)
}

export async function prepareCatalogDelta(
  client: ObjectStore,
  config: PublishConfig,
  replacements: ReadonlyMap<string, CatalogDeltaReplacement>,
  sourceStatus: Partial<SkillMarket.SourceStatus>,
  createdAt = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<CatalogDelta> {
  validateDeltaReplacements(replacements)
  const pointer = await loadCurrentPointer(client, config)
  const objectKeys = keys(config, pointer.revision)
  const [payload, currentFacets] = await Promise.all([
    loadBytes(client, objectKeys.catalog),
    loadObject(client, objectKeys.facets, SkillMarket.Facets),
  ])
  const catalog = parseCatalogBytes(payload)
  if (catalog.revision !== pointer.revision || currentFacets.revision !== pointer.revision)
    throw new Error("OSS snapshot revision mismatch")
  const nextSourceStatus = { ...currentFacets.sourceStatus, ...sourceStatus }
  const hash = new Bun.CryptoHasher("sha256").update('{"entries":[')
  const counts = facetCounts()
  const references = new Map<string, CatalogDetailRef>()
  const encoder = new TextEncoder()
  let itemBytes = 0
  let position = 0
  for (const item of catalog.items()) {
    if (signal?.aborted) throw new Error("catalog delta preparation aborted")
    const entryKey = key(item.summary.source, item.summary.id)
    const entry = selectDeltaEntry(entryKey, item, replacements.get(entryKey))
    if (position > 0) {
      hash.update(",")
      itemBytes++
    }
    hash.update(JSON.stringify([entryKey, { summary: entry.summary, ref: entry.ref }]))
    itemBytes += encoder.encode(JSON.stringify({ summary: entry.summary, detail: entry.ref })).byteLength
    addFacetCounts(counts, entry.summary)
    if (replacements.has(entryKey)) references.set(entryKey, entry.ref)
    position++
  }
  if (references.size !== replacements.size) throw new Error("catalog delta replacement is absent")
  const revision = hash.update(`],"sourceStatus":${JSON.stringify(nextSourceStatus)}}`).digest("hex")
  const facets = buildDeltaFacets(revision, nextSourceStatus, counts)
  const header = `{"schemaVersion":2,"revision":${JSON.stringify(revision)},"createdAt":${JSON.stringify(createdAt)},"items":[`
  const contentLength = encoder.encode(header).byteLength + itemBytes + 2
  const parts = () => deltaCatalogParts(catalog, header, replacements, signal)
  return {
    revision,
    createdAt,
    facets,
    references,
    contentLength,
    body: () => encodeJsonChunks(parts()),
  }
}

export async function publishCatalogDeltaObjects(
  client: ObjectStore,
  config: PublishConfig,
  delta: CatalogDelta,
  changedDetails: ReadonlyMap<string, SkillMarket.Detail>,
) {
  if (!client.putStream) throw new Error("catalog delta streaming is unavailable")
  if (changedDetails.size !== delta.references.size) throw new Error("catalog delta details do not match replacements")
  const objectKeys = keys(config, delta.revision)
  const details = Array.from(changedDetails, ([entryKey, detail]) => {
    const ref = delta.references.get(entryKey)
    if (!ref) throw new Error(`changed catalog detail is absent from the delta: ${entryKey}`)
    const body = JSON.stringify(detail)
    const digest = sha256(new TextEncoder().encode(body))
    if (ref.sha256 !== digest || ref.key !== `details/${digest}.json`)
      throw new Error(`changed catalog detail does not match its delta reference: ${entryKey}`)
    return { body, digest }
  })
  for (const detail of details)
    await client.put(
      `${objectKeys.details}/${detail.digest}.json`,
      detail.body,
      "application/json",
      "public, max-age=31536000, immutable",
      { sha256: detail.digest },
    )
  await client.putStream(
    objectKeys.catalog,
    delta.body(),
    delta.contentLength,
    "application/json",
    "public, max-age=31536000, immutable",
  )
  const facetsBody = JSON.stringify(delta.facets)
  await client.put(objectKeys.facets, facetsBody, "application/json", "public, max-age=31536000, immutable")
  const [catalogMetadata, publishedFacets] = await Promise.all([
    client.head(objectKeys.catalog),
    loadObject(client, objectKeys.facets, SkillMarket.Facets),
    ...details.map(async (detail) => {
      const body = await loadBytes(client, `${objectKeys.details}/${detail.digest}.json`)
      if (sha256(body) !== detail.digest) throw new Error(`published detail hash mismatch: ${detail.digest}`)
    }),
  ])
  if (catalogMetadata.size !== delta.contentLength) throw new Error("published catalog length mismatch")
  if (publishedFacets.revision !== delta.revision) throw new Error("published catalog facets mismatch")
}

async function publishCatalogObjects(
  client: ObjectStore,
  config: PublishConfig,
  index: CatalogIndex,
  changedDetails: ReadonlyMap<string, SkillMarket.Detail>,
) {
  const objectKeys = keys(config, index.revision)
  validateCatalogIndex(index)
  const details = Array.from(changedDetails, ([entryKey, detail]) => {
    const ref = index.details.get(entryKey)
    if (!ref) throw new Error(`changed catalog detail is absent from the index: ${entryKey}`)
    const body = JSON.stringify(detail)
    const digest = sha256(new TextEncoder().encode(body))
    if (ref.sha256 !== digest || ref.key !== `details/${digest}.json`)
      throw new Error(`changed catalog detail does not match its reference: ${entryKey}`)
    return { ref, body, digest }
  })
  for (const detail of details)
    await client.put(
      `${objectKeys.details}/${detail.digest}.json`,
      detail.body,
      "application/json",
      "public, max-age=31536000, immutable",
      { sha256: detail.digest },
    )
  await putCatalogObject(client, objectKeys.catalog, index)
  await client.put(
    objectKeys.facets,
    JSON.stringify(index.facets),
    "application/json",
    "public, max-age=31536000, immutable",
  )
  await validateCatalogObjects(client, objectKeys, index, details)
}

async function publishCatalogPointer(client: ObjectStore, config: PublishConfig, index: Pick<CatalogIndex, "revision" | "createdAt">) {
  const objectKeys = keys(config, index.revision)
  await client.put(
    objectKeys.current,
    JSON.stringify({ revision: index.revision, createdAt: index.createdAt }),
    "application/json",
    "public, max-age=60",
  )
  return { revision: index.revision, pointerKey: objectKeys.current }
}

async function putCatalogObject(client: ObjectStore, objectKey: string, index: CatalogIndex) {
  if (!client.putStream)
    return client.put(
      objectKey,
      JSON.stringify({
        schemaVersion: 2,
        revision: index.revision,
        createdAt: index.createdAt,
        items: index.items.map((summary) => ({ summary, detail: index.details.get(key(summary.source, summary.id)) })),
      }),
      "application/json",
      "public, max-age=31536000, immutable",
    )
  const payload = catalogIndexPayload(index)
  return client.putStream(
    objectKey,
    payload.body(),
    payload.contentLength,
    "application/json",
    "public, max-age=31536000, immutable",
  )
}

export async function loadCurrentPointer(client: ObjectStore, config: PublishConfig) {
  return loadObject(client, `${normalizePrefix(config.prefix)}/current.json`, Pointer)
}

export async function loadCatalogIndexOrMissingPointer(client: ObjectStore, config: PublishConfig) {
  try {
    await loadCurrentPointer(client, config)
  } catch (error) {
    if (isMissingObjectError(error)) return undefined
    throw error
  }
  return loadCatalogIndex(client, config)
}

export async function loadCurrentSnapshot(client: ObjectStore, config: PublishConfig): Promise<CatalogSnapshot> {
  const index = await loadCatalogIndex(client, config)
  const loadedDetails = await loadDetails(
    index.items,
    (item) => loadCatalogDetail(client, config, index, item.source, item.id),
  )
  const details = loadedDetails.filter((detail): detail is SkillMarket.Detail => detail !== undefined)
  if (details.length !== index.items.length) throw new Error("OSS snapshot is missing a catalog detail")
  const entries = details.map((detail) => [key(detail.source, detail.id), detail] as const)
  const detailMap = new Map(entries)
  if (detailMap.size !== index.items.length) throw new Error("OSS snapshot contains duplicate catalog keys")
  index.items.forEach((item) => {
    const detail = detailMap.get(key(item.source, item.id))
    if (!detail || detail.version !== item.version)
      throw new Error(`OSS detail does not match catalog item: ${item.source}:${item.id}`)
  })
  return {
    revision: index.revision,
    createdAt: index.createdAt,
    items: [...index.items],
    details: detailMap,
    facets: index.facets,
    sourceStatus: index.sourceStatus,
  }
}

export async function loadCatalogIndex(client: ObjectStore, config: PublishConfig): Promise<CatalogIndex> {
  const prefix = normalizePrefix(config.prefix)
  const pointer = await loadObject(client, `${prefix}/current.json`, Pointer)
  const objectKeys = keys({ prefix }, pointer.revision)
  const [catalogValue, facets] = await Promise.all([
    loadJsonObject(client, objectKeys.catalog),
    loadObject(client, objectKeys.facets, SkillMarket.Facets),
  ])
  const catalog = requireCatalogObject(catalogValue)
  if (catalog.revision !== pointer.revision || facets.revision !== pointer.revision)
    throw new Error("OSS snapshot revision mismatch")
  if ("schemaVersion" in catalog) {
    const details = new Map(
      catalog.items.map((item) => {
        if (item.detail.key !== `details/${item.detail.sha256}.json`) throw new Error("catalog detail key does not match hash")
        return [key(item.summary.source, item.summary.id), { ...item.detail, version: item.summary.version }] as const
      }),
    )
    if (details.size !== catalog.items.length) throw new Error("OSS catalog contains duplicate detail references")
    return {
      revision: catalog.revision,
      createdAt: catalog.createdAt,
      items: catalog.items.map((item) => item.summary),
      details,
      facets,
      sourceStatus: facets.sourceStatus,
    }
  }
  return {
    revision: catalog.revision,
    createdAt: catalog.createdAt,
    items: [...catalog.items],
    details: new Map(
      catalog.items.map((item) => [
        key(item.source, item.id),
        { key: `details/${item.source}/${encodeURIComponent(item.id)}.json`, sha256: "", version: item.version },
      ] as const),
    ),
    facets,
    sourceStatus: facets.sourceStatus,
  }
}

export async function loadCatalogDetail(
  client: ObjectStore,
  config: PublishConfig,
  index: CatalogIndex,
  source: SkillMarket.Source,
  id: string,
) {
  const ref = index.details.get(key(source, id))
  if (!ref) return undefined
  const body = await loadBytes(
    client,
    Schema.is(SkillMarket.Sha256)(ref.sha256)
      ? `${normalizePrefix(config.prefix)}/${ref.key}`
      : `${keys(config, index.revision).root}/${ref.key}`,
  )
  if (Schema.is(SkillMarket.Sha256)(ref.sha256) && sha256(body) !== ref.sha256)
    throw new Error(`OSS detail hash mismatch: ${ref.key}`)
  const json = await Schema.decodeUnknownPromise(Schema.UnknownFromJsonString)(new TextDecoder().decode(body))
  const detail = await Schema.decodeUnknownPromise(SkillMarket.Detail)(json)
  if (detail.source !== source || detail.id !== id || detail.version !== ref.version)
    throw new Error(`OSS detail does not match catalog item: ${source}:${id}`)
  return detail
}

function keys(config: PublishConfig, revision: string) {
  const prefix = normalizePrefix(config.prefix)
  if (!/^[a-zA-Z0-9._-]+$/.test(revision)) throw new Error("snapshot revision contains invalid characters")
  return {
    current: `${prefix}/current.json`,
    details: `${prefix}/details`,
    root: `${prefix}/indexes/${revision}`,
    catalog: `${prefix}/indexes/${revision}/catalog.json`,
    facets: `${prefix}/indexes/${revision}/facets.json`,
    detail: (source: SkillMarket.Source, id: string) =>
      `${prefix}/indexes/${revision}/details/${source}/${encodeURIComponent(id)}.json`,
  }
}

async function validateCatalogObjects(
  client: ObjectStore,
  objectKeys: ReturnType<typeof keys>,
  index: CatalogIndex,
  details: ReadonlyArray<{ readonly ref: { readonly key: string; readonly sha256: string } }>,
) {
  const [catalog, facets] = await Promise.all([
    loadObject(client, objectKeys.catalog, CatalogObjectV2),
    loadObject(client, objectKeys.facets, SkillMarket.Facets),
  ])
  if (catalog.revision !== index.revision || facets.revision !== index.revision)
    throw new Error("published OSS object revision mismatch")
  if (catalog.items.length !== index.items.length)
    throw new Error("published OSS object count mismatch")
  await mapBatches(
    details,
    async (detail) => {
      const body = await loadBytes(client, `${objectKeys.details}/${detail.ref.sha256}.json`)
      if (sha256(body) !== detail.ref.sha256) throw new Error(`published detail hash mismatch: ${detail.ref.key}`)
    },
  )
}

async function loadObject<S extends Schema.Decoder<unknown>>(client: ObjectStore, key: string, schema: S) {
  const body = await loadBytes(client, key)
  const json = await Schema.decodeUnknownPromise(Schema.UnknownFromJsonString)(new TextDecoder().decode(body))
  return Schema.decodeUnknownPromise(schema)(json)
}

async function loadJsonObject(client: ObjectStore, key: string) {
  const json = decodeJsonBytes(await loadBytes(client, key))
  Bun.gc(true)
  return json
}

function decodeJsonBytes(body: Uint8Array) {
  return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(new TextDecoder().decode(body))
}

function parseJsonBytes(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(body))
}

async function loadBytes(client: ObjectStore, key: string) {
  const [metadata, body] = await Promise.all([client.head(key), client.get(key)])
  if (metadata.size !== body.byteLength) throw new Error(`OSS object size mismatch: ${key}`)
  return body
}

async function loadDetails<T, R>(items: ReadonlyArray<T>, load: (item: T) => Promise<R>) {
  return mapBatches(items, load)
}

async function mapBatches<T, R>(items: ReadonlyArray<T>, map: (item: T) => Promise<R>) {
  const results: R[] = []
  for (const chunk of Array.from({ length: Math.ceil(items.length / 32) }, (_, index) =>
    items.slice(index * 32, index * 32 + 32),
  ))
    results.push(...(await Promise.all(chunk.map(map))))
  return results
}

function indexFromSnapshot(snapshot: CatalogSnapshot): CatalogIndex {
  return {
    revision: snapshot.revision,
    createdAt: snapshot.createdAt,
    items: snapshot.items,
    details: new Map(
      Array.from(snapshot.details, ([entryKey, detail]) => {
        const hash = sha256(new TextEncoder().encode(JSON.stringify(detail)))
        return [entryKey, { key: `details/${hash}.json`, sha256: hash, version: detail.version }] as const
      }),
    ),
    facets: snapshot.facets,
    sourceStatus: snapshot.sourceStatus,
  }
}

function validateCatalogIndex(index: CatalogIndex) {
  if (!Schema.is(SkillMarket.Facets)(index.facets) || index.facets.revision !== index.revision)
    throw new Error("catalog facets do not match the index revision")
  if (index.details.size !== index.items.length) throw new Error("catalog index has missing detail references")
  const entries = new Set<string>()
  index.items.forEach((item) => {
    const entryKey = key(item.source, item.id)
    const ref = index.details.get(entryKey)
    if (!ref || ref.key !== `details/${ref.sha256}.json` || !Schema.is(SkillMarket.Sha256)(ref.sha256))
      throw new Error(`catalog detail reference is invalid: ${entryKey}`)
    if (entries.has(entryKey)) throw new Error(`catalog index contains duplicate item: ${entryKey}`)
    entries.add(entryKey)
  })
}

function isV2(value: unknown): value is { readonly schemaVersion: 2 } {
  return typeof value === "object" && value !== null && (value as { schemaVersion?: unknown }).schemaVersion === 2
}

function requireCatalogObject(value: unknown) {
  if (isV2(value)) {
    if (!Schema.is(CatalogObjectV2)(value)) throw new Error("OSS v2 catalog is invalid")
    return value
  }
  if (!Schema.is(CatalogObjectV1)(value)) throw new Error("OSS v1 catalog is invalid")
  return value
}

type CatalogItem = typeof CatalogItemV2.Type
type FacetCounts = {
  readonly sources: Map<SkillMarket.Source, number>
  readonly categories: Map<string, number>
  readonly requiresApiKey: { yes: number; no: number }
}

function validateDeltaReplacements(replacements: ReadonlyMap<string, CatalogDeltaReplacement>) {
  if (replacements.size < 1 || replacements.size > 100) throw new Error("catalog delta must contain between 1 and 100 replacements")
  replacements.forEach((replacement, entryKey) => {
    if (key(replacement.summary.source, replacement.summary.id) !== entryKey)
      throw new Error(`catalog delta replacement key mismatch: ${entryKey}`)
    if (!Schema.is(SkillMarket.Sha256)(replacement.expectedSha256))
      throw new Error(`catalog delta expected hash is invalid: ${entryKey}`)
    if (!Schema.is(SkillMarket.Sha256)(replacement.ref.sha256))
      throw new Error(`catalog delta replacement hash is invalid: ${entryKey}`)
    if (replacement.ref.key !== `details/${replacement.ref.sha256}.json`)
      throw new Error(`catalog delta detail key mismatch: ${entryKey}`)
    if (replacement.ref.version !== replacement.summary.version)
      throw new Error(`catalog delta replacement version mismatch: ${entryKey}`)
  })
}

function selectDeltaEntry(entryKey: string, item: CatalogItem, replacement: CatalogDeltaReplacement | undefined) {
  if (item.detail.key !== `details/${item.detail.sha256}.json`)
    throw new Error(`catalog detail key does not match hash: ${entryKey}`)
  if (!replacement)
    return {
      summary: item.summary,
      ref: { key: item.detail.key, sha256: item.detail.sha256, version: item.summary.version },
    }
  if (item.detail.sha256 !== replacement.expectedSha256) throw new Error(`catalog delta replacement is stale: ${entryKey}`)
  return { summary: replacement.summary, ref: replacement.ref }
}

function parseCatalogBytes(body: Uint8Array) {
  const marker = new TextEncoder().encode('"items":[')
  const markerStart = findBytes(body, marker)
  if (markerStart < 0) throw new Error("OSS v2 catalog items are missing")
  const itemsStart = markerStart + marker.byteLength
  const header = Schema.decodeUnknownSync(CatalogObjectV2)(
    decodeJsonBytes(new TextEncoder().encode(`${new TextDecoder().decode(body.subarray(0, itemsStart))}]}`)),
  )
  if (header.items.length !== 0) throw new Error("OSS v2 catalog header is invalid")
  return {
    revision: header.revision,
    createdAt: header.createdAt,
    *items() {
      let position = skipWhitespace(body, itemsStart)
      let decoded = 0
      if (body[position] === 93) {
        validateCatalogTail(body, position + 1)
        return
      }
      while (position < body.byteLength) {
        if (body[position] !== 123) throw new Error("OSS v2 catalog item is invalid")
        const end = catalogObjectEnd(body, position)
        // Avoid an Effect decoder copy for every item; the catalog contains
        // enough short-lived objects to exceed the evaluation worker cgroup.
        const item = parseJsonBytes(body.subarray(position, end))
        if (!Schema.is(CatalogItemV2)(item)) throw new Error("OSS v2 catalog item schema is invalid")
        yield item
        decoded++
        if (decoded % 4096 === 0) Bun.gc(true)
        position = skipWhitespace(body, end)
        if (body[position] === 44) {
          position = skipWhitespace(body, position + 1)
          continue
        }
        if (body[position] !== 93) throw new Error("OSS v2 catalog item separator is invalid")
        validateCatalogTail(body, position + 1)
        return
      }
      throw new Error("OSS v2 catalog is truncated")
    },
  }
}

function findBytes(body: Uint8Array, expected: Uint8Array) {
  for (let start = 0; start <= body.byteLength - expected.byteLength; start++) {
    let matched = true
    for (let offset = 0; offset < expected.byteLength; offset++)
      if (body[start + offset] !== expected[offset]) {
        matched = false
        break
      }
    if (matched) return start
  }
  return -1
}

function catalogObjectEnd(body: Uint8Array, start: number) {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let position = start; position < body.byteLength; position++) {
    const value = body[position]
    if (quoted) {
      if (escaped) {
        escaped = false
        continue
      }
      if (value === 92) {
        escaped = true
        continue
      }
      if (value === 34) quoted = false
      continue
    }
    if (value === 34) {
      quoted = true
      continue
    }
    if (value === 123) depth++
    if (value !== 125) continue
    depth--
    if (depth === 0) return position + 1
  }
  throw new Error("OSS v2 catalog item is truncated")
}

function skipWhitespace(body: Uint8Array, start: number) {
  let position = start
  while ([9, 10, 13, 32].includes(body[position] ?? -1)) position++
  return position
}

function validateCatalogTail(body: Uint8Array, start: number) {
  const end = skipWhitespace(body, start)
  if (body[end] !== 125 || skipWhitespace(body, end + 1) !== body.byteLength)
    throw new Error("OSS v2 catalog tail is invalid")
}

function facetCounts(): FacetCounts {
  return { sources: new Map(), categories: new Map(), requiresApiKey: { yes: 0, no: 0 } }
}

function addFacetCounts(counts: FacetCounts, item: SkillMarket.Summary) {
  if (item.delisted) return
  counts.sources.set(item.source, (counts.sources.get(item.source) ?? 0) + 1)
  item.categories.forEach((category) => counts.categories.set(category, (counts.categories.get(category) ?? 0) + 1))
  if (item.requiresApiKey) {
    counts.requiresApiKey.yes++
    return
  }
  counts.requiresApiKey.no++
}

function buildDeltaFacets(revision: string, sourceStatus: SkillMarket.SourceStatus, counts: FacetCounts): SkillMarket.Facets {
  return {
    revision,
    sourceStatus,
    sources: Array.from(counts.sources, ([value, count]) => ({ value, count })).toSorted((left, right) =>
      left.value.localeCompare(right.value),
    ),
    categories: Array.from(counts.categories, ([value, count]) => ({ value, count })).toSorted(
      (left, right) => right.count - left.count || left.value.localeCompare(right.value),
    ),
    requiresApiKey: counts.requiresApiKey,
  }
}

export function catalogIndexPayload(index: CatalogIndex) {
  const encoder = new TextEncoder()
  const parts = () => catalogIndexParts(index)
  let contentLength = 0
  for (const part of parts()) contentLength += encoder.encode(part).byteLength
  return {
    contentLength,
    body: () => encodeJsonChunks(parts()),
  }
}

function* deltaCatalogParts(
  catalog: ReturnType<typeof parseCatalogBytes>,
  header: string,
  replacements: ReadonlyMap<string, CatalogDeltaReplacement>,
  signal?: AbortSignal,
) {
  yield header
  let position = 0
  for (const item of catalog.items()) {
    if (signal?.aborted) throw new Error("catalog delta stream aborted")
    const entryKey = key(item.summary.source, item.summary.id)
    const entry = selectDeltaEntry(entryKey, item, replacements.get(entryKey))
    yield `${position > 0 ? "," : ""}${JSON.stringify({ summary: entry.summary, detail: entry.ref })}`
    position++
  }
  yield "]}"
}

async function* encodeJsonChunks(parts: Iterable<string>) {
  const encoder = new TextEncoder()
  let buffer = new Uint8Array(256 * 1024)
  let offset = 0
  for (const part of parts) {
    const bytes = encoder.encode(part)
    if (bytes.byteLength > buffer.byteLength) {
      if (offset > 0) yield buffer.slice(0, offset)
      yield bytes
      buffer = new Uint8Array(256 * 1024)
      offset = 0
      continue
    }
    if (offset + bytes.byteLength > buffer.byteLength) {
      yield buffer.slice(0, offset)
      buffer = new Uint8Array(256 * 1024)
      offset = 0
    }
    buffer.set(bytes, offset)
    offset += bytes.byteLength
  }
  if (offset > 0) yield buffer.slice(0, offset)
}

function* catalogIndexParts(index: CatalogIndex) {
  yield `{"schemaVersion":2,"revision":${JSON.stringify(index.revision)},"createdAt":${JSON.stringify(index.createdAt)},"items":[`
  for (const [position, summary] of index.items.entries()) {
    if (position > 0) yield ","
    yield JSON.stringify({ summary, detail: index.details.get(key(summary.source, summary.id)) })
  }
  yield "]}"
}

function sha256(body: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex")
}

function normalizePrefix(prefix: string) {
  const value = prefix.replace(/^\/+|\/+$/g, "")
  if (!value || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("OSS prefix is invalid")
  return value
}
