import matter from "gray-matter"
import { deflateRawSync } from "node:zlib"
import type { SkillHubRecord } from "./skillhub"
import { inspectZipArchive } from "./submission-archive"

const skillID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export interface NormalizedSkillHubArchive {
  readonly id: string
  readonly description: string
  readonly readme: string
  readonly license?: string
  readonly body: Uint8Array
  readonly sha256: string
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string; readonly size: number }>
  readonly repairs: ReadonlyArray<"name-replaced" | "description-added" | "manifest-rebuilt" | "root-promoted">
}

export function normalizeSkillHubArchive(body: Uint8Array, record: SkillHubRecord): NormalizedSkillHubArchive {
  const archive = inspectZipArchive(body, {
    compressed: 50 * 1024 * 1024,
    expanded: 100 * 1024 * 1024,
    files: 1_000,
    retainedContent: Number.POSITIVE_INFINITY,
    requireRootSkill: false,
  })
  const root = archive.entries.find((entry) => entry.path === "SKILL.md")
  const candidates = archive.entries.filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"))
  const skill = root ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!skill) throw new Error("archive must contain exactly one recoverable SKILL.md")
  const skillRoot = root ? undefined : skill.path.slice(0, skill.path.lastIndexOf("/") + 1)

  const id = normalizedID(record.slug)
  const markdown = matter(decoder.decode(skill.content))
  const originalName = metadataString(markdown.data, "name")
  const originalDescription = metadataString(markdown.data, "description")
  const description = originalDescription ?? (record.description.trim() || "SkillHub skill")
  const rewrittenSkill = encoder.encode(
    matter.stringify(markdown.content, { ...markdown.data, name: id, description }),
  )
  const repairs: NormalizedSkillHubArchive["repairs"][number][] = []
  if (originalName !== id) repairs.push("name-replaced")
  if (!originalDescription) repairs.push("description-added")
  if (!root) repairs.push("root-promoted")

  const normalizedEntries = archive.entries
    .map((entry) =>
      entry === skill
        ? { path: "SKILL.md", content: rewrittenSkill }
        : {
            path: skillRoot && entry.path.startsWith(skillRoot) ? entry.path.slice(skillRoot.length) : entry.path,
            content: entry.content,
          },
    )
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  if (new Set(normalizedEntries.map((entry) => entry.path)).size !== normalizedEntries.length)
    throw new Error("nested Skill promotion path conflict")
  const normalizedBody = writeZip(normalizedEntries)
  const files = normalizedEntries.map((entry) => ({
    path: entry.path,
    sha256: sha256(entry.content),
    size: entry.content.byteLength,
  }))
  if (!sameManifest(record.files, files)) repairs.push("manifest-rebuilt")

  const license = metadataString(markdown.data, "license")
  return {
    id,
    description,
    readme: markdown.content,
    ...(license ? { license } : {}),
    body: normalizedBody,
    sha256: sha256(normalizedBody),
    files,
    repairs,
  }
}

function normalizedID(slug: string) {
  if (skillID.test(slug)) return slug
  const base = slug
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `${(base || "skill").slice(0, 115)}-${sha256(encoder.encode(slug)).slice(0, 12)}`
}

function metadataString(metadata: unknown, field: string) {
  if (!metadata || typeof metadata !== "object") return undefined
  const value = Reflect.get(metadata, field)
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function sameManifest(
  expected: SkillHubRecord["files"],
  actual: ReadonlyArray<{ readonly path: string; readonly sha256: string; readonly size: number }>,
) {
  if (expected.length !== actual.length) return false
  const entries = new Map(actual.map((entry) => [entry.path, entry]))
  return expected.every((entry) => {
    const value = entries.get(entry.path)
    return value?.sha256 === entry.sha256 && value.size === entry.size
  })
}

function writeZip(entries: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array }>) {
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  entries.forEach((entry) => {
    const name = encoder.encode(entry.path)
    const compressed = new Uint8Array(deflateRawSync(entry.content))
    const crc = crc32(entry.content)
    const header = new Uint8Array(30 + name.byteLength)
    const headerView = new DataView(header.buffer)
    headerView.setUint32(0, 0x04034b50, true)
    headerView.setUint16(4, 20, true)
    headerView.setUint16(6, 0x0800, true)
    headerView.setUint16(8, 8, true)
    headerView.setUint32(14, crc, true)
    headerView.setUint32(18, compressed.byteLength, true)
    headerView.setUint32(22, entry.content.byteLength, true)
    headerView.setUint16(26, name.byteLength, true)
    header.set(name, 30)
    local.push(header, compressed)

    const directory = new Uint8Array(46 + name.byteLength)
    const directoryView = new DataView(directory.buffer)
    directoryView.setUint32(0, 0x02014b50, true)
    directoryView.setUint16(4, 0x0314, true)
    directoryView.setUint16(6, 20, true)
    directoryView.setUint16(8, 0x0800, true)
    directoryView.setUint16(10, 8, true)
    directoryView.setUint32(16, crc, true)
    directoryView.setUint32(20, compressed.byteLength, true)
    directoryView.setUint32(24, entry.content.byteLength, true)
    directoryView.setUint16(28, name.byteLength, true)
    directoryView.setUint32(38, 0o100644 * 2 ** 16, true)
    directoryView.setUint32(42, offset, true)
    directory.set(name, 46)
    central.push(directory)
    offset += header.byteLength + compressed.byteLength
  })
  const centralSize = central.reduce((size, entry) => size + entry.byteLength, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  return concat([...local, ...central, end])
}

function concat(parts: ReadonlyArray<Uint8Array>) {
  const body = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  parts.reduce((offset, part) => {
    body.set(part, offset)
    return offset + part.byteLength
  }, 0)
  return body
}

function crc32(body: Uint8Array) {
  let crc = 0xffffffff
  body.forEach((value) => {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  })
  return (crc ^ 0xffffffff) >>> 0
}

function sha256(body: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex")
}
