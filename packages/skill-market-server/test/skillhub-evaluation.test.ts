import { describe, expect, test } from "bun:test"
import { loadSkillHubEvaluation } from "../src/skillhub-evaluation"
import { SkillHubRequestError } from "../src/skillhub"

const evaluation = {
  createdAt: "2026-07-21T00:00:00.000Z",
  dimensions: {
    trust: { items: { provenance: { score: 5 } } },
    reliability: { items: { tests: { score: 4 } } },
    adaptability: { items: { inputs: { score: 4 }, outputs: { score: 4.6 } } },
    convention: { items: { naming: { score: 4 }, structure: { score: 4.65 } } },
    effectiveness: { items: { clarity: { score: 4.5 }, results: { score: 4.75 } } },
  },
  skillId: "skill_123",
  summary: "ignored",
  updatedAt: "2026-07-21T00:00:00.000Z",
  versionId: "version_123",
}

describe("SkillHub evaluations", () => {
  test("calculates means from named criteria at the encoded evaluation endpoint", async () => {
    const requested: string[] = []
    const result = await loadSkillHubEvaluation(
      async (input) => {
        requested.push(String(input))
        return Response.json(evaluation)
      },
      "https://api.skillhub.cn/base",
      "review / audit",
    )

    expect(requested).toEqual(["https://api.skillhub.cn/api/v1/skills/review%20%2F%20audit/evaluation"])
    expect(result).toEqual({
      trust: 5,
      reliability: 4,
      adaptability: 4.3,
      convention: 4.325,
      effectiveness: 4.625,
      score: 4.45,
    })
  })

  test.each([
    ["a missing dimension", { ...evaluation, dimensions: { ...evaluation.dimensions, trust: undefined } }],
    ["empty items", { ...evaluation, dimensions: { ...evaluation.dimensions, trust: { items: {} } } }],
    ["score below zero", { ...evaluation, dimensions: { ...evaluation.dimensions, trust: { items: { provenance: { score: -0.1 } } } } }],
    ["score above five", { ...evaluation, dimensions: { ...evaluation.dimensions, trust: { items: { provenance: { score: 5.1 } } } } }],
  ])("rejects %s", async (_name, body) => {
    await expect(loadSkillHubEvaluation(async () => Response.json(body), "https://api.skillhub.cn", "skill")).rejects.toBeInstanceOf(
      SkillHubRequestError,
    )
  })

  test("rejects NaN scores returned by the upstream JSON parser", async () => {
    const response = Response.json(null)
    Object.defineProperty(response, "json", {
      value: async () => ({
        ...evaluation,
        dimensions: { ...evaluation.dimensions, trust: { items: { provenance: { score: NaN } } } },
      }),
    })

    await expect(loadSkillHubEvaluation(async () => response, "https://api.skillhub.cn", "skill")).rejects.toBeInstanceOf(
      SkillHubRequestError,
    )
  })

  test("rejects non-success responses without exposing their bodies", async () => {
    const rejected = loadSkillHubEvaluation(
      async () => new Response("internal upstream details", { status: 503 }),
      "https://api.skillhub.cn",
      "skill",
    )

    await expect(rejected).rejects.toBeInstanceOf(SkillHubRequestError)
    await expect(rejected).rejects.not.toThrow("internal upstream details")
  })

  test("rejects redirects outside the configured HTTPS host", async () => {
    const response = Response.json(evaluation)
    Object.defineProperty(response, "url", { value: "https://untrusted.example/api/v1/skills/skill/evaluation" })

    const rejected = loadSkillHubEvaluation(async () => response, "https://api.skillhub.cn", "skill")

    await expect(rejected).rejects.toMatchObject({
      permanent: true,
      message: "SkillHub redirected outside its API host",
    })
  })

  test("rejects malformed JSON", async () => {
    await expect(
      loadSkillHubEvaluation(async () => new Response("{not json"), "https://api.skillhub.cn", "skill"),
    ).rejects.toBeInstanceOf(SkillHubRequestError)
  })
})
