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

  test("decodes discriminated publication audiences", () => {
    expect(
      Schema.decodeUnknownSync(SkillMarketControl.AudienceTarget)({
        scope: "groups",
        groupIDs: ["grp_alpha", "grp_beta"],
      }),
    ).toEqual({ scope: "groups", groupIDs: ["grp_alpha", "grp_beta"] })
    expect(() =>
      Schema.decodeUnknownSync(SkillMarketControl.AudienceTarget)({
        scope: "department",
        groupIDs: ["grp_alpha"],
      }),
    ).toThrow()
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
