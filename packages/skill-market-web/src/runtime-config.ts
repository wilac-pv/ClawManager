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
