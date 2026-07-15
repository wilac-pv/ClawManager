import path from "path"
import { expect, test } from "bun:test"
import {
  ArchiveLimitError,
  extractZip,
  inspectZip,
  UnsafeArchiveError,
  type ZipLimits,
} from "@opencode-ai/core/skill/zip"
import { tmpdir } from "../fixture/tmpdir"

const fixtures = path.join(import.meta.dir, "../fixtures/skill-market")
const limits = {
  archiveBytes: 50 * 1024 * 1024,
  extractedBytes: 200 * 1024 * 1024,
  files: 2_000,
  ratio: 100,
} satisfies ZipLimits

test("extracts a valid skill and rejects unsafe archive entries", async () => {
  await using tmp = await tmpdir()
  const manifest = await extractZip({
    archive: path.join(fixtures, "valid.zip"),
    destination: path.join(tmp.path, "valid"),
    limits,
  })
  expect(manifest.files.map((file) => file.path)).toContain("SKILL.md")
  expect(await Bun.file(path.join(tmp.path, "valid", "SKILL.md")).text()).toContain("name: code-review")

  for (const name of ["traversal.zip", "absolute.zip", "symlink.zip", "hardlink.zip"]) {
    const destination = path.join(tmp.path, name)
    await expect(extractZip({ archive: path.join(fixtures, name), destination, limits })).rejects.toBeInstanceOf(
      UnsafeArchiveError,
    )
    expect(await Bun.file(destination).exists()).toBe(false)
  }
})

test("rejects archive, expanded-size, file-count and ratio limits before extraction", async () => {
  const valid = path.join(fixtures, "valid.zip")
  await expect(inspectZip({ archive: path.join(fixtures, "bomb.zip"), limits })).rejects.toMatchObject({
    _tag: "ArchiveLimitError",
    limit: "ratio",
  })

  const cases: [keyof ZipLimits, ZipLimits][] = [
    ["archiveBytes", { ...limits, archiveBytes: 1 }],
    ["extractedBytes", { ...limits, extractedBytes: 1 }],
    ["files", { ...limits, files: 1 }],
  ]
  for (const [limit, value] of cases) {
    await expect(inspectZip({ archive: valid, limits: value })).rejects.toEqual(
      expect.objectContaining({ _tag: "ArchiveLimitError", limit }),
    )
  }
})
