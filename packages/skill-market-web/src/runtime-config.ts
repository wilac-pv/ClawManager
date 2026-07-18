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

export function skillDetailUrl(
  pageOrigin: string,
  basePath: string,
  skill: { readonly source: string; readonly id: string },
) {
  const base = new URL(basePath.endsWith("/") ? basePath : `${basePath}/`, pageOrigin)
  return new URL(`skills/${encodeURIComponent(skill.source)}/${encodeURIComponent(skill.id)}`, base).href
}
