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
import { type CatalogIndex, type CatalogSnapshot, key } from "./catalog"

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
const CatalogObjectV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  revision: Schema.String,
  createdAt: SkillMarket.Timestamp,
  items: Schema.Array(
    Schema.Struct({
      summary: SkillMarket.Summary,
      detail: Schema.Struct({ key: Schema.String, sha256: SkillMarket.Sha256 }),
    }),
  ),
})

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
  const body = await loadBytes(client, key)
  return Schema.decodeUnknownPromise(Schema.UnknownFromJsonString)(new TextDecoder().decode(body))
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

export function catalogIndexPayload(index: CatalogIndex) {
  const encoder = new TextEncoder()
  const parts = () => catalogIndexParts(index)
  let contentLength = 0
  for (const part of parts()) contentLength += encoder.encode(part).byteLength
  return {
    contentLength,
    async *body() {
      for (const part of parts()) yield encoder.encode(part)
    },
  }
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
