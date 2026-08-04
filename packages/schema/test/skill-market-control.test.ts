import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SkillMarketControl } from "../src/skill-market-control"

const metadata = {
  version: "1.2.0",
  displayName: "Code Review",
  description: "Review a change before it is merged.",
  category: "Development",
  tags: ["review", "quality"],
  license: "MIT",
  requiresApiKey: false,
  changeNotes: "Add repository review guidance.",
}

const submission = {
  id: "sub_abcdefgh",
  skillID: "code-review",
  owner: { employeeID: "owner", displayName: "Owner" },
  targetVersion: "1.2.0",
  status: "pending_review",
  currentRevision: 1,
  version: 1,
  risk: "safe",
  createdAt: "2026-08-04T00:00:00Z",
  updatedAt: "2026-08-04T00:00:00Z",
} as const

describe("SkillMarketControl", () => {
  test("keeps the complete submission state vocabulary closed", () => {
    expect(Schema.decodeUnknownSync(SkillMarketControl.SubmissionStatus)("pending_review")).toBe("pending_review")
    expect(() => Schema.decodeUnknownSync(SkillMarketControl.SubmissionStatus)("approved")).toThrow()
    expect(SkillMarketControl.ActiveSubmissionStatuses).toEqual([
      "validating",
      "validation_failed",
      "pending_review",
      "changes_requested",
      "publishing",
      "publish_failed",
    ])
    expect(SkillMarketControl.TerminalSubmissionStatuses).toEqual(["rejected", "published"])
  })

  test("decodes every publication audience with only its matching target details", () => {
    const decode = Schema.decodeUnknownSync(SkillMarketControl.AudienceTarget)
    const department = { id: "engineering", name: "Engineering" }
    const groupIDs = ["grp_alphaaaa", "grp_betabbbb"]

    expect(decode({ scope: "personal" })).toEqual({ scope: "personal" })
    expect(decode({ scope: "company" })).toEqual({ scope: "company" })
    expect(decode({ scope: "department", department })).toEqual({ scope: "department", department })
    expect(decode({ scope: "groups", groupIDs })).toEqual({ scope: "groups", groupIDs })

    for (const invalid of [
      { scope: "personal", department },
      { scope: "company", groupIDs },
      { scope: "department" },
      { scope: "department", groupIDs },
      { scope: "groups", department, groupIDs },
      { scope: "groups", groupIDs: [] },
      { scope: "groups", groupIDs: Array.from({ length: 51 }, (_, index) => `grp_${String(index).padStart(8, "0")}`) },
    ]) {
      expect(() => decode(invalid)).toThrow()
    }
  })

  test("keeps department submission audiences scope-only and rejects spoofed identity", () => {
    const decode = Schema.decodeUnknownSync(SkillMarketControl.AudienceInput)

    expect(decode({ scope: "department" })).toEqual({ scope: "department" })
    expect(decode({ scope: "groups", groupIDs: ["grp_alphaaaa"] })).toEqual({
      scope: "groups",
      groupIDs: ["grp_alphaaaa"],
    })
    expect(() =>
      decode({ scope: "department", department: { id: "executive", name: "Executive" } }),
    ).toThrow()
    expect(() => decode({ scope: "department", groupIDs: ["grp_alphaaaa"] })).toThrow()
  })

  test("preserves scalar legacy submission targets and requires matching scoped audiences", () => {
    const decodeCreate = Schema.decodeUnknownSync(SkillMarketControl.SubmissionCreateInput)
    const decodeSummary = Schema.decodeUnknownSync(SkillMarketControl.SubmissionSummary)
    const decodeDetail = Schema.decodeUnknownSync(SkillMarketControl.SubmissionDetail)

    for (const target of ["personal", "company"] as const) {
      expect(decodeCreate({ target, metadata })).toEqual({ target, metadata })
      expect(decodeSummary({ ...submission, target })).toEqual({ ...submission, target })
    }
    expect(decodeSummary(submission)).toEqual(submission)
    expect(
      decodeCreate({ target: "groups", audience: { scope: "groups", groupIDs: ["grp_alphaaaa"] }, metadata }),
    ).toMatchObject({ target: "groups", audience: { scope: "groups", groupIDs: ["grp_alphaaaa"] } })
    expect(
      decodeCreate({ target: "department", audience: { scope: "department" }, metadata }),
    ).toMatchObject({ target: "department", audience: { scope: "department" } })
    expect(
      decodeSummary({
        ...submission,
        target: "department",
        audience: { scope: "department", department: { id: "engineering", name: "Engineering" } },
      }).audience,
    ).toEqual({ scope: "department", department: { id: "engineering", name: "Engineering" } })

    for (const invalid of [
      { target: "personal", audience: { scope: "groups", groupIDs: ["grp_alphaaaa"] }, metadata },
      { target: "company", audience: { scope: "department" }, metadata },
      { target: "groups", metadata },
      { target: "department", metadata },
      { target: "groups", audience: { scope: "department" }, metadata },
      { target: "department", audience: { scope: "groups", groupIDs: ["grp_alphaaaa"] }, metadata },
      {
        target: "department",
        audience: { scope: "department", department: { id: "executive", name: "Executive" } },
        metadata,
      },
    ]) {
      expect(() => decodeCreate(invalid)).toThrow()
    }
    expect(() =>
      decodeSummary({
        ...submission,
        target: "groups",
        audience: { scope: "department", department: { id: "engineering", name: "Engineering" } },
      }),
    ).toThrow()
    expect(() =>
      decodeDetail({
        ...submission,
        target: "groups",
        audience: { scope: "department", department: { id: "engineering", name: "Engineering" } },
        metadata,
        revisions: [],
        reviews: [],
        timeline: [],
      }),
    ).toThrow()
  })

  test("enforces group identifiers and metadata bounds", () => {
    const decodeID = Schema.decodeUnknownSync(SkillMarketControl.GroupID)
    const decodeCreate = Schema.decodeUnknownSync(SkillMarketControl.GroupCreateInput)

    expect(decodeID(`grp_${"a".repeat(8)}`)).toBe(`grp_${"a".repeat(8)}`)
    expect(decodeID(`grp_${"a".repeat(64)}`)).toBe(`grp_${"a".repeat(64)}`)
    for (const invalid of [`grp_${"a".repeat(7)}`, `grp_${"a".repeat(65)}`, "grp_invalid!"]) {
      expect(() => decodeID(invalid)).toThrow()
    }

    expect(decodeCreate({ name: "a".repeat(100), description: "b".repeat(500) })).toEqual({
      name: "a".repeat(100),
      description: "b".repeat(500),
    })
    for (const invalid of [
      { name: " " },
      { name: "a".repeat(101) },
      { name: "group", description: " " },
      { name: "group", description: "b".repeat(501) },
    ]) {
      expect(() => decodeCreate(invalid)).toThrow()
    }
  })

  test("supports partial group metadata patches and explicit description clearing", () => {
    const decode = Schema.decodeUnknownSync(SkillMarketControl.GroupUpdateInput)

    expect(decode({ expectedVersion: 1, name: "Renamed" })).toEqual({ expectedVersion: 1, name: "Renamed" })
    expect(decode({ expectedVersion: 2, description: null })).toEqual({ expectedVersion: 2, description: null })
    expect(decode({ expectedVersion: 3, description: "Updated" })).toEqual({
      expectedVersion: 3,
      description: "Updated",
    })
    expect(decode({ expectedVersion: 4, name: "Renamed", description: null })).toEqual({
      expectedVersion: 4,
      name: "Renamed",
      description: null,
    })
    expect(() => decode({ expectedVersion: 5 })).toThrow()
    expect(() => decode({ expectedVersion: 4, description: " " })).toThrow()
  })

  test("restricts promotion targets to reviewed non-personal audiences", () => {
    const decode = Schema.decodeUnknownSync(SkillMarketControl.PromotionInput)
    const decodeChange = Schema.decodeUnknownSync(SkillMarketControl.AudienceChangeInput)

    expect(decode({ expectedVersion: 1, target: "company" })).toEqual({ expectedVersion: 1, target: "company" })
    expect(
      decode({
        expectedVersion: 2,
        target: "groups",
        audience: { scope: "groups", groupIDs: ["grp_alphaaaa"] },
      }),
    ).toMatchObject({ target: "groups", audience: { scope: "groups", groupIDs: ["grp_alphaaaa"] } })
    expect(
      decode({ expectedVersion: 3, target: "department", audience: { scope: "department" } }),
    ).toMatchObject({ target: "department", audience: { scope: "department" } })
    expect(() => decode({ expectedVersion: 1, target: "personal" })).toThrow()
    expect(() => decode({ expectedVersion: 1, target: "groups" })).toThrow()
    expect(() =>
      decode({ expectedVersion: 1, target: "department", audience: { scope: "groups", groupIDs: ["grp_alphaaaa"] } }),
    ).toThrow()
    expect(() =>
      decode({
        expectedVersion: 1,
        target: "department",
        audience: { scope: "department", department: { id: "executive", name: "Executive" } },
      }),
    ).toThrow()

    expect(decodeChange({ expectedVersion: 1, target: "personal" })).toEqual({
      expectedVersion: 1,
      target: "personal",
    })
    expect(() =>
      decodeChange({
        expectedVersion: 1,
        target: "company",
        audience: { scope: "groups", groupIDs: ["grp_alphaaaa"] },
      }),
    ).toThrow()
  })

  test("bounds restricted publication identifiers", () => {
    const decode = Schema.decodeUnknownSync(SkillMarketControl.PublicationID)

    expect(decode(`pub_${"a".repeat(8)}`)).toBe(`pub_${"a".repeat(8)}`)
    expect(decode(`pub_${"a".repeat(64)}`)).toBe(`pub_${"a".repeat(64)}`)
    expect(() => decode(`pub_${"a".repeat(7)}`)).toThrow()
    expect(() => decode(`pub_${"a".repeat(65)}`)).toThrow()
  })

  test("validates bounded submission metadata and canonical semver", () => {
    expect(Schema.decodeUnknownSync(SkillMarketControl.SubmissionMetadata)(metadata).version).toBe("1.2.0")
    expect(() =>
      Schema.decodeUnknownSync(SkillMarketControl.SubmissionMetadata)({ ...metadata, version: "01.2.0" }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(SkillMarketControl.SubmissionMetadata)({
        ...metadata,
        tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
      }),
    ).toThrow()
  })

  test("decodes a session without accepting arbitrary roles", () => {
    const session = {
      user: { employeeID: "E12345", displayName: "测试用户" },
      roles: ["reviewer"],
      csrfToken: "c".repeat(43),
      createdAt: "2026-07-15T00:00:00.000Z",
      absoluteExpiresAt: "2026-07-15T12:00:00.000Z",
      idleExpiresAt: "2026-07-15T02:00:00.000Z",
    }
    expect(Schema.decodeUnknownSync(SkillMarketControl.Session)(session).roles).toEqual(["reviewer"])
    expect(() => Schema.decodeUnknownSync(SkillMarketControl.Session)({ ...session, roles: ["owner"] })).toThrow()
  })

  test("keeps scan evidence redacted and structured", () => {
    const report = Schema.decodeUnknownSync(SkillMarketControl.ScanReport)({
      risk: "warning",
      reasons: ["检测到脚本文件"],
      evidence: [
        {
          rule: "script.shell",
          summary: "Shell 脚本需要人工确认",
          path: "scripts/check.sh",
          line: 1,
        },
      ],
      scannedAt: "2026-07-15T00:01:00.000Z",
    })
    expect(report.evidence[0]).toEqual({
      rule: "script.shell",
      summary: "Shell 脚本需要人工确认",
      path: "scripts/check.sh",
      line: 1,
    })
  })

  test("exposes community row versions for optimistic status operations", () => {
    expect(
      Schema.decodeUnknownSync(SkillMarketControl.PublicSkill)({
        source: "community",
        id: "safe-skill",
        version: "1.2.0",
        rowVersion: 3,
        status: "published",
      }).rowVersion,
    ).toBe(3)
  })

  test("decodes stable public problems without internal details", () => {
    const problem = Schema.decodeUnknownSync(SkillMarketControl.Problem)({
      code: "submission-conflict",
      message: "投稿已发生变化，请刷新后重试",
      requestId: "req_01J2ABCDEF",
    })
    expect(problem).toEqual({
      code: "submission-conflict",
      message: "投稿已发生变化，请刷新后重试",
      requestId: "req_01J2ABCDEF",
    })
  })
})
