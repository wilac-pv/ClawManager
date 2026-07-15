export * as SkillZip from "./zip"

import { createWriteStream } from "node:fs"
import { mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { Schema } from "effect"
import yauzl from "yauzl"
import { FSUtil } from "../fs-util"

export type ZipLimits = {
  archiveBytes: number
  extractedBytes: number
  files: number
  ratio: number
}

export type ZipFile = {
  path: string
  compressedSize: number
  size: number
  mode: number
}

export type ZipManifest = {
  files: readonly ZipFile[]
  compressedSize: number
  extractedSize: number
}

export class UnsafeArchiveError extends Schema.TaggedErrorClass<UnsafeArchiveError>()("UnsafeArchiveError", {
  path: Schema.String,
  reason: Schema.String,
}) {}

export class ArchiveLimitError extends Schema.TaggedErrorClass<ArchiveLimitError>()("ArchiveLimitError", {
  limit: Schema.Literals(["archiveBytes", "extractedBytes", "files", "ratio"]),
  actual: Schema.Number,
}) {}

export async function inspectZip(input: { archive: string; limits: ZipLimits }) {
  const size = (await stat(input.archive)).size
  if (size > input.limits.archiveBytes) {
    throw new ArchiveLimitError({ limit: "archiveBytes", actual: size })
  }
  const archive = await openArchive(input.archive)
  return readEntries(archive)
    .then((entries) => manifest(entries, input.limits))
    .finally(() => archive.close())
}

export function extractZip(input: { archive: string; destination: string; limits: ZipLimits }) {
  return extract(input).catch(async (error) => {
    await rm(input.destination, { recursive: true, force: true })
    throw error
  })
}

async function extract(input: { archive: string; destination: string; limits: ZipLimits }) {
  const inspected = await inspectZip(input)
  await rm(input.destination, { recursive: true, force: true })
  await mkdir(input.destination, { recursive: true })
  const archive = await openArchive(input.archive)
  await extractEntries(archive, input).finally(() => archive.close())
  return inspected
}

async function extractEntries(
  archive: yauzl.ZipFile,
  input: { archive: string; destination: string; limits: ZipLimits },
) {
  const entries = await readEntries(archive)
  manifest(entries, input.limits)
  let extracted = 0
  for (const entry of entries) {
    const target = safeDestination(input.destination, entry.fileName)
    if (directory(entry)) {
      await mkdir(target, { recursive: true })
      continue
    }
    await mkdir(path.dirname(target), { recursive: true })
    const source = await openEntry(archive, entry)
    let written = 0
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.byteLength
        extracted += chunk.byteLength
        if (written > entry.uncompressedSize || extracted > input.limits.extractedBytes) {
          callback(new ArchiveLimitError({ limit: "extractedBytes", actual: extracted }))
          return
        }
        callback(null, chunk)
      },
    })
    await pipeline(source, limiter, createWriteStream(target, { flags: "wx", mode: mode(entry) & 0o777 || 0o644 }))
    if (written !== entry.uncompressedSize) {
      throw new UnsafeArchiveError({ path: entry.fileName, reason: "size-mismatch" })
    }
  }
}

function openArchive(file: string) {
  return new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      file,
      { autoClose: false, lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (error, archive) => {
        if (error) {
          reject(archiveError(error))
          return
        }
        resolve(archive)
      },
    )
  })
}

function readEntries(archive: yauzl.ZipFile) {
  return new Promise<yauzl.Entry[]>((resolve, reject) => {
    const entries: yauzl.Entry[] = []
    archive.once("error", (error) => reject(archiveError(error)))
    archive.on("entry", (entry: yauzl.Entry) => {
      entries.push(entry)
      archive.readEntry()
    })
    archive.once("end", () => resolve(entries))
    archive.readEntry()
  })
}

function archiveError(error: unknown) {
  return new UnsafeArchiveError({
    path: "<central-directory>",
    reason: error instanceof Error ? error.message : "invalid-archive",
  })
}

function openEntry(archive: yauzl.ZipFile, entry: yauzl.Entry) {
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stream)
    })
  })
}

function manifest(entries: readonly yauzl.Entry[], limits: ZipLimits): ZipManifest {
  const seen = new Set<string>()
  const files = entries.flatMap((entry) => {
    validateEntry(entry)
    const destination = safeDestination("/skill-market-staging", entry.fileName)
    const key = path.relative("/skill-market-staging", destination).toLocaleLowerCase("en-US")
    if (seen.has(key)) throw new UnsafeArchiveError({ path: entry.fileName, reason: "duplicate-path" })
    seen.add(key)
    if (directory(entry)) return []
    return [
      {
        path: entry.fileName,
        compressedSize: entry.compressedSize,
        size: entry.uncompressedSize,
        mode: mode(entry),
      },
    ]
  })
  if (files.length > limits.files) throw new ArchiveLimitError({ limit: "files", actual: files.length })
  const compressedSize = files.reduce((total, file) => total + file.compressedSize, 0)
  const extractedSize = files.reduce((total, file) => total + file.size, 0)
  if (extractedSize > limits.extractedBytes) {
    throw new ArchiveLimitError({ limit: "extractedBytes", actual: extractedSize })
  }
  const ratios = files.map((file) => (file.size === 0 ? 0 : file.size / file.compressedSize))
  const ratio = Math.max(extractedSize === 0 ? 0 : extractedSize / compressedSize, ...ratios)
  if (!Number.isFinite(ratio) || ratio > limits.ratio) {
    throw new ArchiveLimitError({ limit: "ratio", actual: ratio })
  }
  return { files, compressedSize, extractedSize }
}

function validateEntry(entry: yauzl.Entry) {
  const type = mode(entry) & 0o170000
  if (entry.isEncrypted()) throw new UnsafeArchiveError({ path: entry.fileName, reason: "encrypted" })
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new UnsafeArchiveError({ path: entry.fileName, reason: "unsupported-compression" })
  }
  if (type === 0o120000) throw new UnsafeArchiveError({ path: entry.fileName, reason: "symbolic-link" })
  if (type !== 0 && type !== 0o040000 && type !== 0o100000) {
    throw new UnsafeArchiveError({ path: entry.fileName, reason: "unsupported-file-type" })
  }
  if (entry.extraFields.some((field) => field.id === 0x000d && field.data.byteLength > 12)) {
    throw new UnsafeArchiveError({ path: entry.fileName, reason: "hard-link" })
  }
}

function safeDestination(root: string, name: string) {
  const value = name.endsWith("/") ? name.slice(0, -1) : name
  if (!value || value.includes("\\") || value.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new UnsafeArchiveError({ path: name, reason: "invalid-path" })
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw new UnsafeArchiveError({ path: name, reason: "absolute-path" })
  }
  const normalized = path.posix.normalize(value)
  if (normalized !== value || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new UnsafeArchiveError({ path: name, reason: "invalid-path" })
  }
  const destination = path.resolve(root, ...normalized.split("/"))
  if (!FSUtil.contains(root, destination) || destination === path.resolve(root)) {
    throw new UnsafeArchiveError({ path: name, reason: "path-traversal" })
  }
  return destination
}

function mode(entry: yauzl.Entry) {
  return entry.externalFileAttributes >>> 16
}

function directory(entry: yauzl.Entry) {
  return entry.fileName.endsWith("/") || (mode(entry) & 0o170000) === 0o040000
}
