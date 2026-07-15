import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export async function loadEnterprise(fetcher: Fetcher, input: string, allowedHosts: ReadonlySet<string>) {
  assertAllowed(input, allowedHosts)
  const response = await fetcher(input, { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`enterprise index request failed with ${response.status}`)
  if (response.url) assertAllowed(response.url, allowedHosts)
  const index = await Schema.decodeUnknownPromise(SkillMarket.EnterpriseIndex)(await response.json())
  index.skills.forEach((skill) => {
    if (skill.package) assertAllowed(skill.package.url, allowedHosts)
  })
  return index
}

function assertAllowed(input: string, allowedHosts: ReadonlySet<string>) {
  if (!URL.canParse(input)) throw new Error(`URL is not allowed: ${input}`)
  const url = new URL(input)
  if (url.protocol !== "https:" || url.username || url.password || !allowedHosts.has(url.hostname.toLocaleLowerCase()))
    throw new Error(`URL host is not allowed: ${url.hostname}`)
}
