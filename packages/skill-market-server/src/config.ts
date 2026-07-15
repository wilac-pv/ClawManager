type Environment = Record<string, string | undefined>

export function loadConfig(environment: Environment = process.env) {
  const port = Number(environment.SKILL_MARKET_PORT ?? "4210")
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("SKILL_MARKET_PORT must be an integer from 1 to 65535")

  return Object.freeze({
    port,
    skillhubBaseUrl: httpsUrl("SKILLHUB_BASE_URL", environment.SKILLHUB_BASE_URL ?? "https://api.skillhub.cn"),
    enterpriseIndexUrl: httpsUrl("SKILL_MARKET_ENTERPRISE_INDEX_URL", environment.SKILL_MARKET_ENTERPRISE_INDEX_URL),
    ossEndpoint: httpsUrl("SKILL_MARKET_OSS_ENDPOINT", environment.SKILL_MARKET_OSS_ENDPOINT),
    ossRegion: environment.SKILL_MARKET_OSS_REGION ?? "cn-baoding",
    ossBucket: environment.SKILL_MARKET_OSS_BUCKET ?? "app-platform",
    ossPrefix: environment.SKILL_MARKET_OSS_PREFIX ?? "ai-coding/ruying-code/skill-market",
    publicBaseUrl: httpsUrl("SKILL_MARKET_PUBLIC_BASE_URL", environment.SKILL_MARKET_PUBLIC_BASE_URL),
    allowedHosts: new Set(
      (environment.SKILL_MARKET_ALLOWED_HOSTS ?? "api.skillhub.cn")
        .split(",")
        .map((value) => value.trim().toLocaleLowerCase())
        .filter(Boolean),
    ) as ReadonlySet<string>,
  })
}

export type SkillMarketConfig = ReturnType<typeof loadConfig>

function httpsUrl(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required`)
  if (!URL.canParse(value)) throw new Error(`${name} must be an HTTPS URL without credentials`)
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(`${name} must be an HTTPS URL without credentials`)
  return url.href
}
