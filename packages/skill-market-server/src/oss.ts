import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { Readable } from "node:stream"
import { type CatalogSnapshot, key } from "./catalog"

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
  ) => Promise<void>
  readonly delete: (key: string) => Promise<void>
}

export type PublishConfig = { readonly prefix: string }

export function makeS3ObjectStore(config: {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
}) {
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
          IfNoneMatch: "*",
        }),
      )
    },
    async copy(source, target, contentType, metadata) {
      await client.send(
        new CopyObjectCommand({
          Bucket: config.bucket,
          CopySource: encodeURIComponent(`${config.bucket}/${source}`),
          Key: target,
          CacheControl: "private, no-store",
          ContentType: contentType,
          Metadata: metadata,
          MetadataDirective: "REPLACE",
        }),
      )
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
    },
  } satisfies PrivateObjectStore
}

const Pointer = Schema.Struct({ revision: Schema.String, createdAt: SkillMarket.Timestamp })
const CatalogObject = Schema.Struct({
  revision: Schema.String,
  createdAt: SkillMarket.Timestamp,
  items: Schema.Array(SkillMarket.Summary),
})

export async function publishSnapshot(client: ObjectStore, config: PublishConfig, snapshot: CatalogSnapshot) {
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
    ...Array.from(snapshot.details.values(), (detail) =>
      client.put(
        objectKeys.detail(detail.source, detail.id),
        JSON.stringify(detail),
        "application/json",
        "public, max-age=31536000, immutable",
      ),
    ),
  ])
  await validatePublished(client, objectKeys, snapshot)
  await client.put(
    objectKeys.current,
    JSON.stringify({ revision: snapshot.revision, createdAt: snapshot.createdAt }),
    "application/json",
    "public, max-age=60",
  )
  return { revision: snapshot.revision, pointerKey: objectKeys.current }
}

export async function loadCurrentSnapshot(client: ObjectStore, config: PublishConfig): Promise<CatalogSnapshot> {
  const prefix = normalizePrefix(config.prefix)
  const pointer = await loadObject(client, `${prefix}/current.json`, Pointer)
  const objectKeys = keys({ prefix }, pointer.revision)
  const [catalog, facets] = await Promise.all([
    loadObject(client, objectKeys.catalog, CatalogObject),
    loadObject(client, objectKeys.facets, SkillMarket.Facets),
  ])
  if (catalog.revision !== pointer.revision || facets.revision !== pointer.revision)
    throw new Error("OSS snapshot revision mismatch")

  const details = await Promise.all(
    catalog.items.map((item) => loadObject(client, objectKeys.detail(item.source, item.id), SkillMarket.Detail)),
  )
  const entries = details.map((detail) => [key(detail.source, detail.id), detail] as const)
  const detailMap = new Map(entries)
  if (detailMap.size !== catalog.items.length) throw new Error("OSS snapshot contains duplicate catalog keys")
  catalog.items.forEach((item) => {
    const detail = detailMap.get(key(item.source, item.id))
    if (!detail || detail.version !== item.version)
      throw new Error(`OSS detail does not match catalog item: ${item.source}:${item.id}`)
  })
  return {
    revision: pointer.revision,
    createdAt: catalog.createdAt,
    items: [...catalog.items],
    details: detailMap,
    facets,
    sourceStatus: facets.sourceStatus,
  }
}

function keys(config: PublishConfig, revision: string) {
  const prefix = normalizePrefix(config.prefix)
  if (!/^[a-zA-Z0-9._-]+$/.test(revision)) throw new Error("snapshot revision contains invalid characters")
  return {
    current: `${prefix}/current.json`,
    catalog: `${prefix}/indexes/${revision}/catalog.json`,
    facets: `${prefix}/indexes/${revision}/facets.json`,
    detail: (source: SkillMarket.Source, id: string) =>
      `${prefix}/indexes/${revision}/details/${source}/${encodeURIComponent(id)}.json`,
  }
}

async function validatePublished(client: ObjectStore, objectKeys: ReturnType<typeof keys>, snapshot: CatalogSnapshot) {
  const [catalog, facets, ...details] = await Promise.all([
    loadObject(client, objectKeys.catalog, CatalogObject),
    loadObject(client, objectKeys.facets, SkillMarket.Facets),
    ...Array.from(snapshot.details.values(), (detail) =>
      loadObject(client, objectKeys.detail(detail.source, detail.id), SkillMarket.Detail),
    ),
  ])
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
  const [metadata, body] = await Promise.all([client.head(key), client.get(key)])
  if (metadata.size !== body.byteLength) throw new Error(`OSS object size mismatch: ${key}`)
  const json = await Schema.decodeUnknownPromise(Schema.UnknownFromJsonString)(new TextDecoder().decode(body))
  return Schema.decodeUnknownPromise(schema)(json)
}

function normalizePrefix(prefix: string) {
  const value = prefix.replace(/^\/+|\/+$/g, "")
  if (!value || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("OSS prefix is invalid")
  return value
}
