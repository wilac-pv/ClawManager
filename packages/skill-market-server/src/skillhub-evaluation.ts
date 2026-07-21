import { type Fetcher, SkillHubRequestError } from "./skillhub"

const dimensions = ["trust", "reliability", "adaptability", "convention", "effectiveness"] as const

export type SkillHubEvaluation = Record<(typeof dimensions)[number], number> & { readonly score: number }

const mean = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0) / values.length

export async function loadSkillHubEvaluation(
  fetcher: Fetcher,
  baseUrl: string,
  slug: string,
  signal?: AbortSignal,
): Promise<SkillHubEvaluation> {
  const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/evaluation`, baseUrl)
  let response: Response
  try {
    response = await fetcher(url, { headers: { accept: "application/json" }, signal })
  } catch {
    throw new SkillHubRequestError("SkillHub evaluation request failed")
  }
  if (!response.ok)
    throw new SkillHubRequestError(
      `SkillHub evaluation request failed with ${response.status}: ${url.pathname}`,
      response.status,
      response.headers.get("retry-after"),
      response.status < 500 && response.status !== 429,
    )
  if (response.url) {
    const finalUrl = new URL(response.url)
    if (finalUrl.protocol !== "https:" || finalUrl.hostname !== url.hostname)
      throw new SkillHubRequestError("SkillHub redirected outside its API host", undefined, undefined, true)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new SkillHubRequestError("SkillHub evaluation response is invalid", undefined, undefined, true)
  }
  try {
    return calculateEvaluation(body)
  } catch {
    throw new SkillHubRequestError("SkillHub evaluation response is invalid", undefined, undefined, true)
  }
}

function calculateEvaluation(value: unknown): SkillHubEvaluation {
  const response = record(value)
  const source = record(response.dimensions)
  const values = dimensions.map((dimension) => mean(scores(source[dimension])))
  return {
    trust: values[0]!,
    reliability: values[1]!,
    adaptability: values[2]!,
    convention: values[3]!,
    effectiveness: values[4]!,
    score: mean(values),
  }
}

function scores(value: unknown) {
  const items = record(record(value).items)
  const result = Object.values(items).map((item) => {
    const score = record(item).score
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 5) throw new Error()
    return score
  })
  if (!result.length) throw new Error()
  return result
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
  return value as Record<string, unknown>
}
