import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import matter from "gray-matter"
import { inflateRawSync } from "node:zlib"
import type { PrivateObjectStore } from "./oss"
import { scanSubmissionFiles, validateSubmissionIcon } from "./scanner"
import { randomSecret } from "./security"

const defaultLimits = {
  compressed: 50 * 1024 * 1024,
  expanded: 200 * 1024 * 1024,
  files: 2_000,
  ratio: 100,
  retainedContent: 1024 * 1024,
}

interface ArchiveEntry {
  readonly path: string
  readonly content: Uint8Array
  readonly sha256: string
  readonly size: number
  readonly mime: string
}

export type SubmissionPart =
  | {
      readonly type: "field"
      readonly name: "metadata"
      readonly value: string
    }
  | {
      readonly type: "file"
      readonly name: "package" | "icon"
      readonly filename: string
      readonly contentType: string
      readonly stream: Iterable<Uint8Array> | AsyncIterable<Uint8Array>
    }

interface ReceiveContext {
  readonly store: PrivateObjectStore
  readonly privatePrefix: string
  readonly employeeID: string
  readonly submissionID: string
  readonly revision: number
  readonly compressedLimit?: number
  readonly log?: (message: string) => void
}

export interface ReceivedSubmission {
  readonly metadata: SkillMarketControl.SubmissionMetadata
  readonly package: { readonly key: string; readonly sha256: string; readonly size: number }
  readonly icon?: { readonly key: string; readonly sha256: string; readonly size: number; readonly mime: string }
}

export function receiveSubmission(
  parts: Iterable<SubmissionPart> | AsyncIterable<SubmissionPart>,
  context: ReceiveContext,
) {
  const touched: string[] = []
  return receive(parts, context, touched).then(
    (value) => value,
    async (error) => {
      await Promise.all(
        touched.map((key) =>
          context.store.delete(key).then(
            () => undefined,
            () => undefined,
          ),
        ),
      )
      context.log?.("submission upload failed; private details redacted")
      throw error
    },
  )
}

export async function validateQuarantinedSubmission(
  received: ReceivedSubmission,
  store: PrivateObjectStore,
  now: () => number = Date.now,
) {
  const body = await store.get(received.package.key)
  if (
    body.byteLength !== received.package.size ||
    new Bun.CryptoHasher("sha256").update(body).digest("hex") !== received.package.sha256
  )
    throw new Error("quarantine package does not match upload")
  const result = validateSubmissionArchive(body, received.metadata, now)
  const directory = received.package.key.replace(/package\.zip$/, "")
  await Promise.all([
    putJson(store, `${directory}manifest.json`, result.manifest),
    putJson(store, `${directory}scan.json`, result.scan),
  ])
  return result
}

async function receive(
  parts: Iterable<SubmissionPart> | AsyncIterable<SubmissionPart>,
  context: ReceiveContext,
  touched: string[],
) {
  const prefix = normalizePrefix(context.privatePrefix)
  if (
    !/^sub_[a-zA-Z0-9_-]{8,64}$/.test(context.submissionID) ||
    !Number.isInteger(context.revision) ||
    context.revision < 1
  )
    throw new Error("submission quarantine identity is invalid")
  const base = `${prefix}/submissions/${new Bun.CryptoHasher("sha256").update(context.employeeID).digest("hex")}/${context.submissionID}/${context.revision}`
  let metadata: SkillMarketControl.SubmissionMetadata | undefined
  let packageObject: { key: string; sha256: string; size: number } | undefined
  let icon: { key: string; sha256: string; size: number; mime: string } | undefined

  for await (const part of parts) {
    if (part.type === "field") {
      if (metadata) throw new Error("multipart metadata is duplicated")
      const json = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(part.value)
      metadata = Schema.decodeUnknownSync(SkillMarketControl.SubmissionMetadata)(json)
      continue
    }
    if (part.name === "package") {
      if (packageObject) throw new Error("multipart package is duplicated")
      if (part.contentType !== "application/zip" && part.contentType !== "application/octet-stream")
        throw new Error("submission package content type is invalid")
      packageObject = await storePart(
        context,
        touched,
        part.stream,
        `${base}/package.zip`,
        part.contentType,
        context.compressedLimit ?? defaultLimits.compressed,
      )
      continue
    }
    if (icon) throw new Error("multipart icon is duplicated")
    const uploaded = await storePart(
      context,
      touched,
      part.stream,
      `${base}/icon.upload`,
      part.contentType,
      1024 * 1024,
    )
    const body = await context.store.get(uploaded.key)
    const validated = validateSubmissionIcon(body, part.contentType)
    const key = `${base}/icon.${validated.extension}`
    await context.store.copy(uploaded.key, key, part.contentType, { sha256: uploaded.sha256 })
    touched.push(key)
    await context.store.delete(uploaded.key)
    touched.splice(touched.indexOf(uploaded.key), 1)
    icon = { key, sha256: uploaded.sha256, size: uploaded.size, mime: part.contentType }
  }
  if (!metadata) throw new Error("multipart metadata is required")
  if (!packageObject) throw new Error("multipart package is required")
  return { metadata, package: packageObject, ...(icon ? { icon } : {}) }
}

async function storePart(
  context: ReceiveContext,
  touched: string[],
  stream: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  target: string,
  contentType: string,
  limit: number,
) {
  const temporary = `${target}.partial-${randomSecret()}`
  touched.push(temporary)
  const state = { size: 0, hasher: new Bun.CryptoHasher("sha256") }
  await context.store.putPrivate(temporary, limited(stream, limit, state), contentType)
  const sha256 = state.hasher.digest("hex")
  await context.store.copy(temporary, target, contentType, { sha256, size: String(state.size) })
  touched.push(target)
  await context.store.delete(temporary)
  touched.splice(touched.indexOf(temporary), 1)
  return { key: target, sha256, size: state.size }
}

async function* limited(
  stream: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  limit: number,
  state: { size: number; hasher: Bun.CryptoHasher },
) {
  for await (const chunk of stream) {
    state.size += chunk.byteLength
    if (state.size > limit) throw new Error("submission exceeds compressed size limit")
    state.hasher.update(chunk)
    yield chunk
  }
}

export function validateSubmissionArchive(
  body: Uint8Array,
  metadata: SkillMarketControl.SubmissionMetadata,
  now: () => number = Date.now,
) {
  const archive = inspectZipArchive(body)
  const markdown = matter(new TextDecoder("utf-8", { fatal: true }).decode(archive.skill.content))
  const data: unknown = markdown.data
  const skillID = field(data, "name")
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(skillID)) throw new Error("SKILL.md name is not a safe skill id")
  field(data, "description")
  const scan = scanSubmissionFiles(
    archive.entries.map((entry) => ({ path: entry.path, content: entry.content })),
    now,
  )
  return {
    skillID,
    metadata,
    readme: markdown.content,
    manifest: {
      packageSha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
      packageSize: body.byteLength,
      files: archive.entries
        .map((entry) => ({ path: entry.path, sha256: entry.sha256, size: entry.size, mime: entry.mime }))
        .toSorted((left, right) => left.path.localeCompare(right.path)),
    } satisfies SkillMarketControl.Manifest,
    scan: scan.report,
    validationIssues: scan.hasLikelyCredential
      ? [{ code: "likely-credential", message: "Archive appears to contain a credential" }]
      : [],
  }
}

export function inspectZipArchive(body: Uint8Array, overrides: Partial<typeof defaultLimits> = {}) {
  const limits = { ...defaultLimits, ...overrides }
  if (body.byteLength > limits.compressed) throw new Error("archive exceeds compressed size limit")
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const endOffset = findEndRecord(view)
  const entries = view.getUint16(endOffset + 10, true)
  const centralSize = view.getUint32(endOffset + 12, true)
  const centralOffset = view.getUint32(endOffset + 16, true)
  const commentLength = view.getUint16(endOffset + 20, true)
  if (endOffset + 22 + commentLength !== body.byteLength) throw new Error("invalid ZIP end record")
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    throw new Error("ZIP64 archives are not supported")
  if (entries > limits.files) throw new Error("archive exceeds file limit")
  range(body, centralOffset, centralSize)
  if (centralOffset + centralSize !== endOffset) throw new Error("ZIP central directory offset mismatch")

  const output: ArchiveEntry[] = []
  const names = new Set<string>()
  let position = centralOffset
  let expanded = 0
  for (let index = 0; index < entries; index++) {
    range(body, position, 46)
    if (view.getUint32(position, true) !== 0x02014b50) throw new Error("invalid ZIP central directory")
    const flags = view.getUint16(position + 8, true)
    const method = view.getUint16(position + 10, true)
    const expectedCrc = view.getUint32(position + 16, true)
    const compressedSize = view.getUint32(position + 20, true)
    const size = view.getUint32(position + 24, true)
    const nameLength = view.getUint16(position + 28, true)
    const extraLength = view.getUint16(position + 30, true)
    const entryCommentLength = view.getUint16(position + 32, true)
    const externalAttributes = view.getUint32(position + 38, true)
    const localOffset = view.getUint32(position + 42, true)
    range(body, position + 46, nameLength + extraLength + entryCommentLength)
    const path = new TextDecoder("utf-8", { fatal: true }).decode(
      body.subarray(position + 46, position + 46 + nameLength),
    )
    assertPath(path)
    assertExtra(body.subarray(position + 46 + nameLength, position + 46 + nameLength + extraLength))
    if (flags & 1) throw new Error("encrypted ZIP entries are not supported")
    if (method !== 0 && method !== 8) throw new Error(`unsupported ZIP compression method: ${method}`)
    const kind = (externalAttributes >>> 16) & 0xffff & 0o170000
    if (kind === 0o120000) throw new Error(`ZIP symlink is not allowed: ${path}`)
    if (kind !== 0 && kind !== 0o040000 && kind !== 0o100000) throw new Error(`unsupported ZIP entry type: ${path}`)
    if (names.has(path)) throw new Error(`duplicate ZIP path: ${path}`)
    names.add(path)
    position += 46 + nameLength + extraLength + entryCommentLength
    if (path.endsWith("/")) {
      if (size !== 0) throw new Error(`ZIP directory contains data: ${path}`)
      continue
    }
    expanded += size
    if (expanded > limits.expanded) throw new Error("archive exceeds expanded size limit")
    if (size > 0 && (compressedSize === 0 || size / compressedSize > limits.ratio))
      throw new Error("archive exceeds compression ratio limit")
    const content = readEntry(body, view, localOffset, flags, method, compressedSize, size, path)
    if (crc32(content) !== expectedCrc) throw new Error(`ZIP entry CRC mismatch: ${path}`)
    output.push({
      path,
      content: content.subarray(0, limits.retainedContent).slice(),
      sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      size,
      mime: mime(path, content),
    })
  }
  if (position !== centralOffset + centralSize) throw new Error("ZIP central directory size mismatch")
  const skill = output.find((entry) => entry.path === "SKILL.md")
  if (!skill) throw new Error("archive must contain root SKILL.md")
  if (skill.size > limits.retainedContent) throw new Error("root SKILL.md exceeds size limit")
  return { entries: output, skill }
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
  range(body, offset, 30)
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`invalid ZIP local header: ${path}`)
  if (view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method)
    throw new Error(`ZIP header mismatch: ${path}`)
  const nameLength = view.getUint16(offset + 26, true)
  const extraLength = view.getUint16(offset + 28, true)
  range(body, offset + 30, nameLength + extraLength + compressedSize)
  const localPath = new TextDecoder("utf-8", { fatal: true }).decode(
    body.subarray(offset + 30, offset + 30 + nameLength),
  )
  if (localPath !== path) throw new Error(`ZIP local filename mismatch: ${path}`)
  assertExtra(body.subarray(offset + 30 + nameLength, offset + 30 + nameLength + extraLength))
  const compressed = body.subarray(
    offset + 30 + nameLength + extraLength,
    offset + 30 + nameLength + extraLength + compressedSize,
  )
  const content =
    method === 0
      ? compressed.slice()
      : new Uint8Array(inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1) }))
  if (content.byteLength !== size) throw new Error(`ZIP entry size mismatch: ${path}`)
  return content
}

function findEndRecord(view: DataView) {
  const start = Math.max(0, view.byteLength - 65_557)
  for (let offset = view.byteLength - 22; offset >= start; offset--)
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  throw new Error("invalid ZIP end record")
}

function assertPath(path: string) {
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

function assertExtra(extra: Uint8Array) {
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

function range(body: Uint8Array, offset: number, size: number) {
  if (offset < 0 || size < 0 || offset + size > body.byteLength) throw new Error("ZIP entry is out of bounds")
}

function field(input: unknown, name: string) {
  if (!input || typeof input !== "object") throw new Error("SKILL.md frontmatter is required")
  const value = Reflect.get(input, name)
  if (typeof value !== "string" || !value.trim()) throw new Error(`SKILL.md ${name} is required`)
  return value.trim()
}

function mime(path: string, content: Uint8Array) {
  const extension = path.toLocaleLowerCase().split(".").at(-1)
  if (extension === "md") return "text/markdown"
  if (["txt", "log"].includes(extension ?? "")) return "text/plain"
  if (extension === "json") return "application/json"
  if (["js", "mjs", "cjs"].includes(extension ?? "")) return "text/javascript"
  if (extension === "svg") return "image/svg+xml"
  if (content[0] === 0x89 && content[1] === 0x50) return "image/png"
  return "application/octet-stream"
}

function normalizePrefix(prefix: string) {
  const value = prefix.replace(/^\/+|\/+$/g, "")
  if (!value || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("private OSS prefix is invalid")
  return value
}

function crc32(body: Uint8Array) {
  let crc = 0xffffffff
  body.forEach((value) => {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  })
  return (crc ^ 0xffffffff) >>> 0
}

async function putJson(store: PrivateObjectStore, key: string, value: unknown) {
  const body = new TextEncoder().encode(JSON.stringify(value))
  await store.putPrivate(
    key,
    (async function* () {
      yield body
    })(),
    "application/json",
    { sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex") },
  )
}
