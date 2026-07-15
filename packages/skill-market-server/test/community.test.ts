import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  communityIconKey,
  communityPackageKey,
  listPublishedCommunity,
  publishCommunityObjects,
} from "../src/community"
import { openDatabase } from "../src/database"
import type { PrivateObjectStore } from "../src/oss"
import { validateSubmissionArchive } from "../src/submission-archive"
import { makeStoredZip } from "./zip"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("community catalog materialization", () => {
  test("builds the current public detail without exposing employee identity", async () => {
    const fixture = await communityFixture()
    const details = await listPublishedCommunity(fixture.database, communityOptions(fixture))

    expect(details).toHaveLength(1)
    expect(details[0]).toMatchObject({
      id: "community-review",
      source: "community",
      sourceUrl: "https://market.example.com/skills/community/community-review",
      publicDetailUrl: "https://market.example.com/skills/community/community-review",
      version: "1.0.0",
      name: "Community Review",
      readme: "# Community Review\n",
      submittedBy: { displayName: "CONTRIBUTOR" },
      reviewedAt: "2026-07-15T01:00:00.000Z",
      reviewRisk: "safe",
      author: { name: "CONTRIBUTOR" },
      package: {
        url: `https://oss.example.com/skill-market/${communityPackageKey("", "community-review", "1.0.0", fixture.sha256)}`,
        sha256: fixture.sha256,
      },
    })
    expect(details[0]?.versions.map((version) => version.version)).toEqual(["0.9.0", "1.0.0"])
    expect(JSON.stringify(details[0])).not.toContain("E123456")

    fixture.database.connection.run("UPDATE submissions SET status = 'publishing' WHERE id = 'sub_current_12345678'")
    expect(await listPublishedCommunity(fixture.database, communityOptions(fixture))).toEqual([])
    fixture.database.connection.run("UPDATE submissions SET status = 'published' WHERE id = 'sub_current_12345678'")
    fixture.database.connection.run(
      "UPDATE community_skills SET public_status = 'delisted', delist_reason = 'Policy review' WHERE skill_id = 'community-review'",
    )
    expect(await listPublishedCommunity(fixture.database, communityOptions(fixture))).toEqual([])

    fixture.database.close()
  })

  test("copies verified quarantine objects to immutable community keys", async () => {
    const fixture = await communityFixture({ published: false, icon: true })
    const result = await publishCommunityObjects(
      fixture.database,
      { store: fixture.store, publicPrefix: "skill-market" },
      "sub_current_12345678",
    )

    expect(result).toEqual({
      packageKey: communityPackageKey("skill-market", "community-review", "1.0.0", fixture.sha256),
      iconKey: communityIconKey("skill-market", fixture.iconSha256!, "image/png"),
    })
    expect(fixture.objects.get(result.packageKey)).toEqual(fixture.archive)
    expect(fixture.copies.find((copy) => copy.target === result.packageKey)).toMatchObject({
      cacheControl: "public, max-age=31536000, immutable",
      metadata: { sha256: fixture.sha256, size: String(fixture.archive.byteLength) },
    })

    fixture.database.close()
  })

  test("rejects a public object that does not match canonical validation artifacts", async () => {
    const fixture = await communityFixture()
    fixture.objects.set(
      communityPackageKey("skill-market", "community-review", "1.0.0", fixture.sha256),
      new Uint8Array([1, 2, 3]),
    )

    await expect(listPublishedCommunity(fixture.database, communityOptions(fixture))).rejects.toThrow(
      "community package",
    )
    fixture.database.close()
  })

  test("rejects a quarantine icon that no longer matches its validated identity", async () => {
    const fixture = await communityFixture({ published: false, icon: true })
    fixture.objects.set("private/sub_current_12345678/icon.png", new Uint8Array([1, 2, 3]))

    await expect(
      publishCommunityObjects(
        fixture.database,
        { store: fixture.store, publicPrefix: "skill-market" },
        "sub_current_12345678",
      ),
    ).rejects.toThrow("community icon")
    fixture.database.close()
  })
})

async function communityFixture(options: { published?: boolean; icon?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-community-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const archive = makeStoredZip({
    "SKILL.md": "---\nname: community-review\ndescription: Review from the community\n---\n# Community Review\n",
    "references/guide.md": "Review carefully.",
  })
  const metadata = {
    version: "1.0.0",
    displayName: "Community Review",
    description: "Review from the community",
    category: "Development",
    tags: ["review"],
    license: "MIT",
    requiresApiKey: false,
    changeNotes: "Initial release",
  } as const
  const validation = validateSubmissionArchive(archive, metadata, () => Date.parse("2026-07-15T00:30:00.000Z"))
  const sha256 = validation.manifest.packageSha256
  const icon = png()
  const iconSha256 = new Bun.CryptoHasher("sha256").update(icon).digest("hex")
  const objects = new Map<string, Uint8Array>([
    ["private/sub_current_12345678/package.zip", archive],
    ...(options.icon ? ([["private/sub_current_12345678/icon.png", icon]] as const) : []),
  ])
  const metadataByKey = new Map<string, Readonly<Record<string, string>>>()
  if (options.published !== false) {
    const key = communityPackageKey("skill-market", "community-review", "1.0.0", sha256)
    objects.set(key, archive)
    metadataByKey.set(key, { sha256, size: String(archive.byteLength) })
  }
  const copies: Array<{
    source: string
    target: string
    contentType?: string
    metadata?: Readonly<Record<string, string>>
    cacheControl?: string
  }> = []
  const store = memoryStore(objects, metadataByKey, copies)
  const createdAt = Date.parse("2026-07-15T00:00:00.000Z")
  const reviewedAt = Date.parse("2026-07-15T01:00:00.000Z")
  database.transaction((connection) => {
    connection.run(
      "INSERT INTO users (employee_id, display_name, email, created_at, last_login_at) VALUES ('E123456', 'CONTRIBUTOR', 'contributor@example.com', ?, ?)",
      [createdAt, createdAt],
    )
    seedPublishedVersion(connection, {
      submissionID: "sub_previous_12345678",
      version: "0.9.0",
      sha256: "b".repeat(64),
      size: 90,
      metadata: { ...metadata, version: "0.9.0" },
      manifest: { packageSha256: "b".repeat(64), packageSize: 90, files: [] },
      scan: validation.scan,
      createdAt: createdAt - 1_000,
    })
    seedPublishedVersion(connection, {
      submissionID: "sub_current_12345678",
      version: "1.0.0",
      sha256,
      size: archive.byteLength,
      metadata,
      manifest: validation.manifest,
      scan: validation.scan,
      createdAt,
      icon: options.icon
        ? { key: "private/sub_current_12345678/icon.png", sha256: iconSha256, size: icon.byteLength, mime: "image/png" }
        : undefined,
    })
    connection.run(
      `INSERT INTO reviews
        (id, submission_id, revision_number, reviewer_employee_id, decision, created_at)
       VALUES ('review_current_12345678', 'sub_current_12345678', 1, 'E123456', 'approve', ?)`,
      [reviewedAt],
    )
    connection.run(
      `INSERT INTO community_skills
        (skill_id, owner_employee_id, current_version, current_submission_id, public_status, version, created_at, updated_at)
       VALUES ('community-review', 'E123456', '1.0.0', 'sub_current_12345678', 'published', 1, ?, ?)`,
      [createdAt, reviewedAt],
    )
    connection.run(
      `INSERT INTO submissions
        (id, skill_id, owner_employee_id, target_version, status, current_revision, version, created_at, updated_at)
       VALUES ('sub_pending_12345678', 'community-review', 'E123456', '2.0.0', 'pending_review', 1, 2, ?, ?)`,
      [reviewedAt + 1_000, reviewedAt + 1_000],
    )
    connection.run(
      `INSERT INTO submission_revisions
        (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json,
         manifest_json, scan_json, validation_errors_json, validation_completed_at, created_at)
       VALUES ('sub_pending_12345678', 1, 'private/pending.zip', ?, 100, ?, ?, ?, '[]', ?, ?)`,
      [
        "c".repeat(64),
        JSON.stringify({ ...metadata, version: "2.0.0" }),
        JSON.stringify(validation.manifest),
        JSON.stringify(validation.scan),
        reviewedAt + 1_000,
        reviewedAt + 1_000,
      ],
    )
    if (options.published === false)
      connection.run("UPDATE submissions SET status = 'publishing' WHERE id = 'sub_current_12345678'")
  })
  return {
    database,
    store,
    objects,
    metadataByKey,
    copies,
    archive,
    sha256,
    iconSha256: options.icon ? iconSha256 : undefined,
  }
}

function seedPublishedVersion(
  connection: import("bun:sqlite").Database,
  input: {
    submissionID: string
    version: string
    sha256: string
    size: number
    metadata: object
    manifest: object
    scan: object
    createdAt: number
    icon?: { key: string; sha256: string; size: number; mime: string }
  },
) {
  connection.run(
    `INSERT INTO submissions
      (id, skill_id, owner_employee_id, target_version, status, current_revision, version, created_at, updated_at)
     VALUES (?, 'community-review', 'E123456', ?, 'published', 1, 3, ?, ?)`,
    [input.submissionID, input.version, input.createdAt, input.createdAt],
  )
  connection.run(
    `INSERT INTO submission_revisions
      (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json,
       private_icon_json, manifest_json, scan_json, validation_errors_json, validation_completed_at, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    [
      input.submissionID,
      `private/${input.submissionID}/package.zip`,
      input.sha256,
      input.size,
      JSON.stringify(input.metadata),
      input.icon ? JSON.stringify(input.icon) : null,
      JSON.stringify(input.manifest),
      JSON.stringify(input.scan),
      input.createdAt,
      input.createdAt,
    ],
  )
}

function communityOptions(fixture: Awaited<ReturnType<typeof communityFixture>>) {
  return {
    store: fixture.store,
    publicPrefix: "skill-market",
    publicBaseUrl: "https://oss.example.com/skill-market/",
    webBaseUrl: "https://market.example.com/",
  }
}

function memoryStore(
  objects: Map<string, Uint8Array>,
  metadataByKey: Map<string, Readonly<Record<string, string>>>,
  copies: Array<{
    source: string
    target: string
    contentType?: string
    metadata?: Readonly<Record<string, string>>
    cacheControl?: string
  }>,
): PrivateObjectStore {
  return {
    async put(key, body) {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
    },
    async get(key) {
      const body = objects.get(key)
      if (!body) throw new Error(`missing ${key}`)
      return body
    },
    async head(key) {
      const body = objects.get(key)
      if (!body) throw new Error(`missing ${key}`)
      return { size: body.byteLength, metadata: metadataByKey.get(key) }
    },
    async putPrivate(key, body) {
      const chunks = await Array.fromAsync(body)
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      const output = new Uint8Array(size)
      chunks.reduce((offset, chunk) => {
        output.set(chunk, offset)
        return offset + chunk.byteLength
      }, 0)
      objects.set(key, output)
    },
    async copy(source, target, contentType, metadata, cacheControl) {
      const body = objects.get(source)
      if (!body) throw new Error(`missing ${source}`)
      objects.set(target, body.slice())
      if (metadata) metadataByKey.set(target, metadata)
      copies.push({ source, target, contentType, metadata, cacheControl })
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

function png() {
  const body = new Uint8Array(33)
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  body.set(new TextEncoder().encode("IHDR"), 12)
  const view = new DataView(body.buffer)
  view.setUint32(16, 1)
  view.setUint32(20, 1)
  return body
}
