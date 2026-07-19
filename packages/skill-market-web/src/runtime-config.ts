import type { SkillMarket } from "@opencode-ai/schema/skill-market"

type SkillIdentity = Pick<SkillMarket.Detail, "source" | "id">

export function resolveSkillMarketRuntime(
  apiUrl: string | undefined,
  pageOrigin: string,
  allowInsecureHttp: string | undefined,
) {
  const configured = apiUrl?.trim()
  return {
    apiBaseUrl: configured || pageOrigin,
    allowInsecurePrivateHttp: allowInsecureHttp === "true" || !configured,
  }
}

export function skillPackageUrl(apiBaseUrl: string, detail: SkillIdentity) {
  return new URL(`/v1/catalog/skills/${detail.source}/${encodeURIComponent(detail.id)}/package`, apiBaseUrl).href
}

export function skillDetailUrl(pageOrigin: string, basePath: string, detail: SkillIdentity) {
  const base = basePath.endsWith("/") ? basePath : `${basePath}/`
  return new URL(`${base}skills/${detail.source}/${encodeURIComponent(detail.id)}`.replace(/^\/\//, "/"), pageOrigin)
    .href
}
