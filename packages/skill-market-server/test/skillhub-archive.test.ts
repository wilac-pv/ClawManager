import { describe, expect, test } from "bun:test"
import { normalizeSkillHubArchive } from "../src/skillhub-archive"
import { inspectZipArchive } from "../src/submission-archive"
import type { SkillHubRecord } from "../src/skillhub"
import { makeZip } from "./zip"

describe("SkillHub archive normalization", () => {
  test("rebuilds recoverable frontmatter and the package manifest", () => {
    const normalized = normalizeSkillHubArchive(zip({ name: undefined }), record("safe-slug"))

    expect(normalized.id).toBe("safe-slug")
    expect(normalized.repairs).toContain("name-replaced")
    expect(normalized.repairs).toContain("description-added")
    expect(normalized.repairs).toContain("manifest-rebuilt")
    expect(normalized.sha256).toBe(sha256(normalized.body))
    expect(normalized.readme).toBe("# Skill body")
    expect(normalized.files.map((file) => file.path)).toEqual(["SKILL.md", "references/guide.md"])
    expect(inspectZipArchive(normalized.body).entries.map((entry) => entry.path)).toEqual([
      "SKILL.md",
      "references/guide.md",
    ])
    expect(normalizeSkillHubArchive(zip({ name: undefined }), record("safe-slug")).body).toEqual(normalized.body)
  })

  test("derives an ASCII ID from an unsafe SkillHub slug", () => {
    const slug = "中文 名称"
    const normalized = normalizeSkillHubArchive(zip({ name: undefined }), record(slug))

    expect(normalized.id).toBe(`skill-${sha256(new TextEncoder().encode(slug)).slice(0, 12)}`)
  })

  test("replaces an unsafe SkillHub frontmatter name", () => {
    expect(normalizeSkillHubArchive(zip({ name: "中文 名称" }), record("safe-slug")).repairs).toContain("name-replaced")
  })

  test("promotes exactly one nested SKILL.md to the root", () => {
    const normalized = normalizeSkillHubArchive(nestedZip("folder/SKILL.md"), record("safe-slug"))

    expect(normalized.repairs).toContain("root-promoted")
    expect(inspectZipArchive(normalized.body).skill.path).toBe("SKILL.md")
  })

  test("retains hard ZIP path rejections", () => {
    expect(() => normalizeSkillHubArchive(traversalZip(), record("safe-slug"))).toThrow("ZIP path")
  })

  test("retains expanded-size limits", () => {
    expect(() => normalizeSkillHubArchive(oversizedZip(), record("safe-slug"))).toThrow("expanded size")
  })

  test("rejects archives without exactly one recoverable SKILL.md", () => {
    expect(() => normalizeSkillHubArchive(noRecoverableSkillZip(), record("safe-slug"))).toThrow("recoverable SKILL.md")
  })
})

function zip(frontmatter: { readonly name?: string }) {
  const lines = ["---", ...(frontmatter.name === undefined ? [] : [`name: ${frontmatter.name}`]), "---", "# Skill body"]
  return makeZip([
    { name: "SKILL.md", content: lines.join("\n") },
    { name: "references/guide.md", content: "Keep this exact guide." },
  ])
}

function nestedZip(path: string) {
  return makeZip([{ name: path, content: "---\ndescription: Nested\n---\n# Nested body" }])
}

function traversalZip() {
  return makeZip([
    { name: "SKILL.md", content: "---\nname: safe\ndescription: Safe\n---\n# Safe" },
    { name: "../escape", content: "bad" },
  ])
}

function oversizedZip() {
  return makeZip([
    {
      name: "SKILL.md",
      content: "---\nname: safe\ndescription: Safe\n---\n# Safe",
      declaredSize: 100 * 1024 * 1024 + 1,
    },
  ])
}

function noRecoverableSkillZip() {
  return makeZip([
    { name: "first/SKILL.md", content: "# First" },
    { name: "second/SKILL.md", content: "# Second" },
  ])
}

function record(slug: string): SkillHubRecord {
  return {
    slug,
    name: "Catalog name",
    description: "Catalog description",
    categories: ["Development"],
    tags: ["guide"],
    requiresApiKey: false,
    risk: "safe",
    version: "1.0.0",
    updatedAt: "2026-07-17T00:00:00.000Z",
    downloads: 1,
    favorites: 1,
    score: 1,
    sourceUrl: "https://skillhub.cn/skills/safe-slug",
    publicDetailUrl: "https://skillhub.cn/skills/safe-slug",
    author: { name: "SkillHub" },
    files: [{ path: "incorrect.txt", sha256: "0".repeat(64), size: 0 }],
    versions: [{ version: "1.0.0", publishedAt: "2026-07-17T00:00:00.000Z", changelog: "Initial" }],
    securityReports: [],
    downloadUrl: "https://api.skillhub.cn/download/safe-slug",
  }
}

function sha256(body: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex")
}
