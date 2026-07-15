import { describe, expect, test } from "bun:test"
import type { PrivateObjectStore } from "../src/oss"
import { receiveSubmission, validateQuarantinedSubmission, validateSubmissionArchive } from "../src/submission-archive"
import { makeStoredZip, makeZip } from "./zip"

const skill = `---
name: safe-skill
description: A safe submitted skill
license: MIT
---
# Safe Skill

Use this skill carefully.
`

const metadata = {
  version: "1.0.0",
  displayName: "Safe Skill",
  description: "A safe submitted skill",
  category: "Developer Tools",
  tags: ["review"],
  license: "MIT",
  requiresApiKey: false,
  changeNotes: "Initial submission",
}

describe("submitted ZIP validation", () => {
  test("streams multipart files to employee-hashed private quarantine keys", async () => {
    const store = privateStore()
    const archive = makeStoredZip({ "SKILL.md": skill })
    const result = await receiveSubmission(
      [
        filePart("package", "package.zip", "application/zip", [archive.subarray(0, 20), archive.subarray(20)]),
        fieldPart("metadata", JSON.stringify(metadata)),
        filePart("icon", "icon.svg", "image/svg+xml", [
          new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'),
        ]),
      ],
      {
        store: store.client,
        privatePrefix: "private-market",
        employeeID: "E000001",
        submissionID: "sub_abcdefgh",
        revision: 1,
      },
    )

    expect(result.package.size).toBe(archive.byteLength)
    expect(result.package.sha256).toHaveLength(64)
    expect(result.metadata).toEqual(metadata)
    expect(result.package.key).toMatch(/^private-market\/submissions\/[a-f0-9]{64}\/sub_abcdefgh\/1\/package\.zip$/)
    expect(result.package.key).not.toContain("E000001")
    expect(result.icon?.key).toEndWith("/icon.svg")
    expect(store.objects.get(result.package.key)).toEqual(archive)

    const validated = await validateQuarantinedSubmission(result, store.client, () =>
      Date.parse("2026-07-15T00:00:00.000Z"),
    )
    expect(validated.skillID).toBe("safe-skill")
    expect([...store.objects.keys()]).toEqual(
      expect.arrayContaining([
        result.package.key.replace(/package\.zip$/, "manifest.json"),
        result.package.key.replace(/package\.zip$/, "scan.json"),
      ]),
    )
  })

  test("deletes request-scoped objects and redacts private details when multipart streaming fails", async () => {
    const store = privateStore()
    const logs: string[] = []
    const marker = `sk-${"Secret".repeat(8)}`
    const error = await receiveSubmission(
      [filePart("package", "package.zip", "application/zip", [new TextEncoder().encode(marker)])],
      {
        store: store.client,
        privatePrefix: "private-market",
        employeeID: "E000001",
        submissionID: "sub_abcdefgh",
        revision: 1,
        compressedLimit: 8,
        log: (message) => logs.push(message),
      },
    ).then(() => "", String)

    expect(error).toContain("compressed size limit")
    expect(store.deleted).toHaveLength(1)
    expect(JSON.stringify(logs)).not.toContain(marker)
    expect(JSON.stringify(logs)).not.toContain("private-market")
  })

  test("rejects a quarantine object that no longer matches its upload hash and size", async () => {
    const store = privateStore()
    const archive = makeStoredZip({ "SKILL.md": skill })
    const received = await receiveSubmission(
      [
        filePart("package", "package.zip", "application/zip", [archive]),
        fieldPart("metadata", JSON.stringify(metadata)),
      ],
      {
        store: store.client,
        privatePrefix: "private-market",
        employeeID: "E000001",
        submissionID: "sub_abcdefgh",
        revision: 1,
      },
    )
    store.objects.set(received.package.key, makeStoredZip({ "SKILL.md": skill.replace("safe-skill", "other-skill") }))

    const error = await validateQuarantinedSubmission(received, store.client).then(() => "", String)
    expect(error).toContain("quarantine package does not match upload")
  })

  test("returns canonical metadata, manifest, cleaned README, and scan evidence", () => {
    const archive = makeStoredZip({ "SKILL.md": skill, "references/guide.md": "Review carefully.\n" })
    const result = validateSubmissionArchive(archive, metadata, () => Date.parse("2026-07-15T00:00:00.000Z"))

    expect(result.skillID).toBe("safe-skill")
    expect(result.readme).toStartWith("# Safe Skill")
    expect(result.readme).not.toContain("name: safe-skill")
    expect(result.metadata).toEqual(metadata)
    expect(result.manifest.packageSha256).toHaveLength(64)
    expect(result.manifest.packageSize).toBe(archive.byteLength)
    expect(result.manifest.files.map((file) => file.path)).toEqual(["references/guide.md", "SKILL.md"])
    expect(result.scan).toMatchObject({ risk: "safe", scannedAt: "2026-07-15T00:00:00.000Z" })
    expect(result.validationIssues).toEqual([])
  })

  test("rejects oversized, excessive, high-ratio, encrypted, ZIP64, and corrupt archives", () => {
    const cases = [
      ["compressed size", new Uint8Array(50 * 1024 * 1024 + 1)],
      [
        "expanded size",
        makeZip([
          { name: "SKILL.md", content: skill },
          { name: "large.bin", content: "x", declaredSize: 200 * 1024 * 1024 + 1 },
        ]),
      ],
      [
        "compression ratio",
        makeZip([
          { name: "SKILL.md", content: skill },
          { name: "ratio.txt", content: "x", declaredCompressedSize: 1, declaredSize: 101 },
        ]),
      ],
      ["file limit", makeZip(Array.from({ length: 2_001 }, (_, index) => ({ name: `f${index}`, content: "" })))],
      ["encrypted", makeZip([{ name: "SKILL.md", content: skill, flags: 1 }])],
      ["ZIP64", makeZip([{ name: "SKILL.md", content: skill }], { entries: 0xffff })],
      ["invalid ZIP", new Uint8Array([1, 2, 3, 4])],
    ] as const
    cases.forEach(([message, archive]) => expect(() => validateSubmissionArchive(archive, metadata)).toThrow(message))
  })

  test("rejects unsafe, empty, duplicate, mismatched, linked, and unsupported entry paths", () => {
    const cases = [
      [
        "unsafe ZIP path",
        makeZip([
          { name: "/absolute", content: "x" },
          { name: "SKILL.md", content: skill },
        ]),
      ],
      [
        "unsafe ZIP path",
        makeZip([
          { name: "../escape", content: "x" },
          { name: "SKILL.md", content: skill },
        ]),
      ],
      [
        "unsafe ZIP path",
        makeZip([
          { name: "", content: "x" },
          { name: "SKILL.md", content: skill },
        ]),
      ],
      [
        "duplicate ZIP path",
        makeZip([
          { name: "SKILL.md", content: skill },
          { name: "SKILL.md", content: skill },
        ]),
      ],
      ["local filename mismatch", makeZip([{ name: "SKILL.md", localName: "OTHER.md", content: skill }])],
      [
        "symlink",
        makeZip([
          { name: "SKILL.md", content: skill },
          { name: "link", content: "target", mode: 0o120777 },
        ]),
      ],
      [
        "entry type",
        makeZip([
          { name: "SKILL.md", content: skill },
          { name: "device", content: "x", mode: 0o060644 },
        ]),
      ],
    ] as const
    cases.forEach(([message, archive]) => expect(() => validateSubmissionArchive(archive, metadata)).toThrow(message))
  })

  test("requires exactly one root SKILL.md with a safe stable ID", () => {
    expect(() => validateSubmissionArchive(makeStoredZip({ "nested/SKILL.md": skill }), metadata)).toThrow(
      "root SKILL.md",
    )
    expect(() =>
      validateSubmissionArchive(makeStoredZip({ "SKILL.md": skill.replace("safe-skill", "../unsafe") }), metadata),
    ).toThrow("safe skill id")
  })

  test("rejects entry data that does not match its ZIP CRC", () => {
    const archive = makeStoredZip({ "SKILL.md": skill, "guide.txt": "original-guide-content" })
    const marker = new TextEncoder().encode("original-guide-content")
    const offset = findBytes(archive, marker)
    archive[offset] ^= 1

    expect(() => validateSubmissionArchive(archive, metadata)).toThrow("CRC mismatch")
  })
})

function filePart(name: "package" | "icon", filename: string, contentType: string, chunks: Uint8Array[]) {
  return { type: "file" as const, name, filename, contentType, stream: chunks }
}

function fieldPart(name: "metadata", value: string) {
  return { type: "field" as const, name, value }
}

function privateStore() {
  const objects = new Map<string, Uint8Array>()
  const deleted: string[] = []
  const client: PrivateObjectStore = {
    async put() {},
    async get(key) {
      const body = objects.get(key)
      if (!body) throw new Error("missing object")
      return body
    },
    async head(key) {
      const body = objects.get(key)
      if (!body) throw new Error("missing object")
      return { size: body.byteLength }
    },
    async putPrivate(key, body) {
      const chunks: Uint8Array[] = []
      for await (const chunk of body) chunks.push(chunk)
      const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
      chunks.reduce((offset, chunk) => {
        output.set(chunk, offset)
        return offset + chunk.byteLength
      }, 0)
      objects.set(key, output)
    },
    async copy(source, target) {
      const body = objects.get(source)
      if (!body) throw new Error("missing source")
      objects.set(target, body.slice())
    },
    async delete(key) {
      deleted.push(key)
      objects.delete(key)
    },
  }
  return { client, deleted, objects }
}

function findBytes(body: Uint8Array, marker: Uint8Array) {
  for (let offset = 0; offset <= body.byteLength - marker.byteLength; offset++)
    if (marker.every((value, index) => body[offset + index] === value)) return offset
  throw new Error("marker not found")
}
