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
  readonly put: (key: string, body: string | Uint8Array, contentType: string, cacheControl: string) => Promise<void>
  readonly get: (key: string) => Promise<Uint8Array>
  readonly head: (key: string) => Promise<{
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
  ) => Promise<void>
  readonly copy: (
    source: string,
    target: string,
    contentType?: string,
    metadata?: Readonly<Record<string, string>>,
    cacheControl?: string,
  ) => Promise<void>
  readonly delete: (key: string) => Promise<void>
}

export interface MaintenanceObjectStore extends PrivateObjectStore {
  readonly list: (prefix: string) => Promise<ReadonlyArray<{ readonly key: string; readonly lastModified: Date }>>
}

export type PublishConfig = { readonly prefix: string }

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
    async get(key) {
      const output = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
      if (!output.Body) throw new Error(`OSS object has no body: ${key}`)
      return output.Body.transformToByteArray()
    },
    async head(key) {
      const output = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
      if (output.ContentLength === undefined) throw new Error(`OSS object has no content length: ${key}`)
      return {
        size: output.ContentLength,
        ...(output.ContentType ? { contentType: output.ContentType } : {}),
        ...(output.ETag ? { etag: output.ETag } : {}),
        ...(output.Metadata ? { metadata: output.Metadata } : {}),
      }
    },
    async putPrivate(key, body, contentType, metadata) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: Readable.from(body),
          ContentType: contentType,
          CacheControl: "private, no-store",
          Metadata: metadata,
        }),
      )
    },
    async copy(source, target, contentType, metadata, cacheControl) {
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
      )
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
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
  await publishSnapshotObjects(client, config, snapshot)
  await publishSnapshotPointer(client, config, snapshot)
  return { revision: snapshot.revision, pointerKey: keys(config, snapshot.revision).current }
}

export async function publishSnapshotObjects(client: ObjectStore, config: PublishConfig, snapshot: CatalogSnapshot) {
  const objectKeys = keys(config, snapshot.revision)
  await Promise.all([
    client.put(
      objectKeys.catalog,
      JSON.stringify({ revision: snapshot.revision, createdAt: snapshot.createdAt, items: snapshot.items }),
      "application/json",
      "public, max-age=31536000, immutable",
    ),
    client.put(
      objectKeys.facets,
      JSON.stringify(snapshot.facets),
      "application/json",
      "public, max-age=31536000, immutable",
    ),
  ])
  await mapBatches(Array.from(snapshot.details.values()), (detail) =>
    client.put(
      objectKeys.detail(detail.source, detail.id),
      JSON.stringify(detail),
      "application/json",
      "public, max-age=31536000, immutable",
    ),
  )
  await validatePublished(client, objectKeys, snapshot)
  return { revision: snapshot.revision }
}

export async function publishSnapshotPointer(client: ObjectStore, config: PublishConfig, snapshot: CatalogSnapshot) {
  const objectKeys = keys(config, snapshot.revision)
  await client.put(
    objectKeys.current,
    JSON.stringify({ revision: snapshot.revision, createdAt: snapshot.createdAt }),
    "application/json",
    "public, max-age=60",
  )
  return { revision: snapshot.revision, pointerKey: objectKeys.current }
}

export async function loadCurrentPointer(client: ObjectStore, config: PublishConfig) {
  return loadObject(client, `${normalizePrefix(config.prefix)}/current.json`, Pointer)
}

export async function loadCurrentSnapshot(client: ObjectStore, config: PublishConfig): Promise<CatalogSnapshot> {
  const index = await loadCatalogIndex(client, config)
  const loadedDetails = await loadDetails(index.items, (item) =>
    loadCatalogDetail(client, config, index, item.source, item.id),
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
    loadJson(client, objectKeys.catalog),
    loadObject(client, objectKeys.facets, SkillMarket.Facets),
  ])
  const catalog = Schema.is(CatalogObjectV2)(catalogValue)
    ? catalogValue
    : await Schema.decodeUnknownPromise(CatalogObjectV1)(catalogValue)
  if (catalog.revision !== pointer.revision || facets.revision !== pointer.revision)
    throw new Error("OSS snapshot revision mismatch")
  if ("schemaVersion" in catalog) {
    const details = new Map(
      catalog.items.map((item) => {
        if (item.detail.key !== `details/${item.detail.sha256}.json`)
          throw new Error("catalog detail key does not match hash")
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
  const details = new Map(
    catalog.items.map(
      (item) =>
        [
          key(item.source, item.id),
          { key: `details/${item.source}/${encodeURIComponent(item.id)}.json`, sha256: "", version: item.version },
        ] as const,
    ),
  )
  if (details.size !== catalog.items.length) throw new Error("OSS catalog contains duplicate detail references")
  return {
    revision: catalog.revision,
    createdAt: catalog.createdAt,
    items: [...catalog.items],
    details,
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
  const detail = await Schema.decodeUnknownPromise(SkillMarket.Detail)(
    await Schema.decodeUnknownPromise(Schema.UnknownFromJsonString)(new TextDecoder().decode(body)),
  )
  if (detail.source !== source || detail.id !== id || detail.version !== ref.version)
    throw new Error(`OSS detail does not match catalog item: ${source}:${id}`)
  return detail
}

function keys(config: PublishConfig, revision: string) {
  const prefix = normalizePrefix(config.prefix)
  if (!/^[a-zA-Z0-9._-]+$/.test(revision)) throw new Error("snapshot revision contains invalid characters")
  return {
    current: `${prefix}/current.json`,
    root: `${prefix}/indexes/${revision}`,
    catalog: `${prefix}/indexes/${revision}/catalog.json`,
    facets: `${prefix}/indexes/${revision}/facets.json`,
    detail: (source: SkillMarket.Source, id: string) =>
      `${prefix}/indexes/${revision}/details/${source}/${encodeURIComponent(id)}.json`,
  }
}

async function validatePublished(client: ObjectStore, objectKeys: ReturnType<typeof keys>, snapshot: CatalogSnapshot) {
  const [catalog, facets] = await Promise.all([
    loadObject(client, objectKeys.catalog, CatalogObjectV1),
    loadObject(client, objectKeys.facets, SkillMarket.Facets),
  ])
  const details = await loadDetails(Array.from(snapshot.details.values()), (detail) =>
    loadObject(client, objectKeys.detail(detail.source, detail.id), SkillMarket.Detail),
  )
  if (catalog.revision !== snapshot.revision || facets.revision !== snapshot.revision)
    throw new Error("published OSS object revision mismatch")
  if (catalog.items.length !== snapshot.items.length || details.length !== snapshot.details.size)
    throw new Error("published OSS object count mismatch")
  details.forEach((detail) => {
    if (!snapshot.details.has(key(detail.source, detail.id)))
      throw new Error(`published unexpected detail: ${detail.source}:${detail.id}`)
  })
}

async function loadObject<S extends Schema.Decoder<unknown>>(client: ObjectStore, key: string, schema: S) {
  return Schema.decodeUnknownPromise(schema)(await loadJson(client, key))
}

async function loadJson(client: ObjectStore, key: string) {
  return Schema.decodeUnknownPromise(Schema.UnknownFromJsonString)(
    new TextDecoder().decode(await loadBytes(client, key)),
  )
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

function sha256(body: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex")
}

function normalizePrefix(prefix: string) {
  const value = prefix.replace(/^\/+|\/+$/g, "")
  if (!value || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("OSS prefix is invalid")
  return value
}
