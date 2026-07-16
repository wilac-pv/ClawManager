type Environment = Record<string, string | undefined>

export function loadConfig(environment: Environment = process.env) {
  const port = positiveInteger("SKILL_MARKET_PORT", environment.SKILL_MARKET_PORT ?? "4210", 65_535)
  const allowInsecureOssHttp = booleanFlag(
    "SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP",
    environment.SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP,
  )
  const allowInsecurePublicHttp = booleanFlag(
    "SKILL_MARKET_ALLOW_INSECURE_PUBLIC_HTTP",
    environment.SKILL_MARKET_ALLOW_INSECURE_PUBLIC_HTTP,
  )
  const ossPrefix = objectPrefix(
    "SKILL_MARKET_OSS_PREFIX",
    environment.SKILL_MARKET_OSS_PREFIX ?? "ai-coding/ruying-code/skill-market",
  )
  const privateOssPrefix = objectPrefix(
    "SKILL_MARKET_PRIVATE_OSS_PREFIX",
    environment.SKILL_MARKET_PRIVATE_OSS_PREFIX ?? "ai-coding/ruying-code/skill-market-private",
  )
  if (
    privateOssPrefix === ossPrefix ||
    privateOssPrefix.startsWith(`${ossPrefix}/`) ||
    ossPrefix.startsWith(`${privateOssPrefix}/`)
  )
    throw new Error("SKILL_MARKET_PRIVATE_OSS_PREFIX must not overlap SKILL_MARKET_OSS_PREFIX")

  const webUrl = originUrl("SKILL_MARKET_WEB_ORIGIN", environment.SKILL_MARKET_WEB_ORIGIN ?? "http://127.0.0.1:4211")
  const webBasePath = routeBasePath(
    "SKILL_MARKET_WEB_BASE_PATH",
    environment.SKILL_MARKET_WEB_BASE_PATH ?? "/",
  )
  const apiUrl = originUrl(
    "SKILL_MARKET_API_PUBLIC_URL",
    environment.SKILL_MARKET_API_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  )
  const allowInsecureIpHttp = booleanFlag(
    "SKILL_MARKET_ALLOW_INSECURE_IP_HTTP",
    environment.SKILL_MARKET_ALLOW_INSECURE_IP_HTTP,
  )
  validateControlOrigin("SKILL_MARKET_WEB_ORIGIN", webUrl, allowInsecureIpHttp)
  validateControlOrigin("SKILL_MARKET_API_PUBLIC_URL", apiUrl, allowInsecureIpHttp)

  const sessionIdleMinutes = positiveInteger(
    "SKILL_MARKET_SESSION_IDLE_MINUTES",
    environment.SKILL_MARKET_SESSION_IDLE_MINUTES ?? "120",
  )
  const sessionAbsoluteMinutes = positiveInteger(
    "SKILL_MARKET_SESSION_ABSOLUTE_MINUTES",
    environment.SKILL_MARKET_SESSION_ABSOLUTE_MINUTES ?? "720",
  )
  if (sessionIdleMinutes > sessionAbsoluteMinutes)
    throw new Error("SKILL_MARKET_SESSION_IDLE_MINUTES must not exceed SKILL_MARKET_SESSION_ABSOLUTE_MINUTES")

  return Object.freeze({
    port,
    databasePath: environment.SKILL_MARKET_DATABASE_PATH ?? "/var/lib/ruying-skill-market/market.db",
    migrationBackupDirectory:
      environment.SKILL_MARKET_MIGRATION_BACKUP_DIRECTORY ?? "/var/backups/ruying-skill-market/migrations",
    skillhubBaseUrl: httpsUrl("SKILLHUB_BASE_URL", environment.SKILLHUB_BASE_URL ?? "https://api.skillhub.cn"),
    skillhubLimit: optionalPositiveInteger("SKILL_MARKET_SKILLHUB_LIMIT", environment.SKILL_MARKET_SKILLHUB_LIMIT),
    enterpriseIndexUrl: httpsUrl("SKILL_MARKET_ENTERPRISE_INDEX_URL", environment.SKILL_MARKET_ENTERPRISE_INDEX_URL),
    ossEndpoint: ossEndpointUrl(
      "SKILL_MARKET_OSS_ENDPOINT",
      environment.SKILL_MARKET_OSS_ENDPOINT,
      allowInsecureOssHttp,
    ),
    ossRegion: environment.SKILL_MARKET_OSS_REGION ?? "cn-baoding",
    ossBucket: environment.SKILL_MARKET_OSS_BUCKET ?? "app-platform",
    ossPrefix,
    privateOssPrefix,
    publicBaseUrl: publicContentUrl(
      "SKILL_MARKET_PUBLIC_BASE_URL",
      environment.SKILL_MARKET_PUBLIC_BASE_URL,
      allowInsecurePublicHttp,
    ),
    webOrigin: webUrl.origin,
    webBasePath,
    webBaseUrl: new URL(webBasePath, webUrl).href,
    apiPublicUrl: apiUrl.href,
    ssoLoginUrl: httpsUrl(
      "SKILL_MARKET_SSO_LOGIN_URL",
      environment.SKILL_MARKET_SSO_LOGIN_URL ?? "https://sso.gwm.cn/login",
    ),
    adminApiBaseUrl: httpsUrl(
      "SKILL_MARKET_ADMIN_API_BASE_URL",
      environment.SKILL_MARKET_ADMIN_API_BASE_URL ?? "https://aicoding-admin.gwm.cn",
    ),
    cookieSecure: apiUrl.protocol === "https:",
    sessionCookieName: apiUrl.protocol === "https:" ? "__Host-ruying_market_session" : "ruying_market_session",
    loginAttemptMilliseconds:
      positiveInteger("SKILL_MARKET_LOGIN_ATTEMPT_MINUTES", environment.SKILL_MARKET_LOGIN_ATTEMPT_MINUTES ?? "5") *
      60 *
      1_000,
    sessionIdleMilliseconds: sessionIdleMinutes * 60 * 1_000,
    sessionAbsoluteMilliseconds: sessionAbsoluteMinutes * 60 * 1_000,
    sessionCookieMaxAgeSeconds: sessionAbsoluteMinutes * 60,
    dailyUploadLimit: positiveInteger(
      "SKILL_MARKET_DAILY_UPLOAD_LIMIT",
      environment.SKILL_MARKET_DAILY_UPLOAD_LIMIT ?? "20",
    ),
    activeSubmissionLimit: positiveInteger(
      "SKILL_MARKET_ACTIVE_SUBMISSION_LIMIT",
      environment.SKILL_MARKET_ACTIVE_SUBMISSION_LIMIT ?? "5",
    ),
    bootstrapAdmins: uniqueEmployeeIDs(environment.SKILL_MARKET_BOOTSTRAP_ADMIN_EMPLOYEE_IDS),
    allowedHosts: new Set(
      (environment.SKILL_MARKET_ALLOWED_HOSTS ?? "api.skillhub.cn")
        .split(",")
        .map((value) => value.trim().toLocaleLowerCase())
        .filter(Boolean),
    ) as ReadonlySet<string>,
  })
}

function positiveInteger(name: string, value: string, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error(
      `${name} must be a positive integer${maximum === Number.MAX_SAFE_INTEGER ? "" : ` up to ${maximum}`}`,
    )
  return parsed
}

function optionalPositiveInteger(name: string, value: string | undefined) {
  return value === undefined ? undefined : positiveInteger(name, value)
}

function booleanFlag(name: string, value: string | undefined) {
  if (value === undefined) return false
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`${name} must be true or false`)
}

function objectPrefix(name: string, value: string) {
  const prefix = value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/")
  if (!prefix || prefix.split("/").some((segment) => segment === "." || segment === ".."))
    throw new Error(`${name} must be a non-empty object prefix without dot segments`)
  return prefix
}

function routeBasePath(name: string, value: string) {
  const segments = value.split("/").filter(Boolean)
  if (
    !value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    segments.some((segment) => segment === "." || segment === ".." || !/^[a-zA-Z0-9._~-]+$/.test(segment))
  )
    throw new Error(`${name} must be an absolute URL path without credentials, query, fragment, or dot segments`)
  return segments.length === 0 ? "/" : `/${segments.join("/")}/`
}

function uniqueEmployeeIDs(value: string | undefined) {
  const employeeIDs = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ]
  if (employeeIDs.some((employeeID) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(employeeID)))
    throw new Error("SKILL_MARKET_BOOTSTRAP_ADMIN_EMPLOYEE_IDS contains an invalid employee ID")
  return employeeIDs
}

function validateControlOrigin(name: string, url: URL, allowInsecureIpHttp: boolean) {
  if (url.protocol === "https:") return
  if (isLoopback(url.hostname)) return
  if (!isPrivateIPv4(url.hostname))
    throw new Error(`${name} must use HTTPS unless it is a loopback or private IPv4 address`)
  if (!allowInsecureIpHttp)
    throw new Error(`${name} requires SKILL_MARKET_ALLOW_INSECURE_IP_HTTP=true for private-IP testing`)
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

function isPrivateIPv4(hostname: string) {
  const octets = hostname.split(".").map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  if (octets[0] === 10) return true
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true
  return octets[0] === 192 && octets[1] === 168
}

function originUrl(name: string, value: string) {
  if (!URL.canParse(value)) throw new Error(`${name} must be an HTTP or HTTPS origin without credentials`)
  const url = new URL(value)
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`${name} must be an HTTP or HTTPS origin without credentials`)
  return url
}

function httpsUrl(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required`)
  if (!URL.canParse(value)) throw new Error(`${name} must be an HTTPS URL without credentials`)
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(`${name} must be an HTTPS URL without credentials`)
  return url.href
}

function ossEndpointUrl(name: string, value: string | undefined, allowInsecureHttp: boolean) {
  if (!value || !URL.canParse(value)) throw new Error(`${name} must be an HTTP or HTTPS URL without credentials`)
  const url = new URL(value)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
    throw new Error(`${name} must be an HTTP or HTTPS URL without credentials`)
  if (url.protocol === "http:" && !allowInsecureHttp)
    throw new Error(`${name} requires SKILL_MARKET_ALLOW_INSECURE_OSS_HTTP=true for internal testing`)
  return url.href
}

function publicContentUrl(name: string, value: string | undefined, allowInsecureHttp: boolean) {
  if (!value || !URL.canParse(value)) throw new Error(`${name} must be an HTTP or HTTPS URL without credentials`)
  const url = new URL(value)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
    throw new Error(`${name} must be an HTTP or HTTPS URL without credentials`)
  if (url.protocol === "https:") return url.href
  if (!allowInsecureHttp)
    throw new Error(`${name} requires SKILL_MARKET_ALLOW_INSECURE_PUBLIC_HTTP=true for private-IP testing`)
  if (!isPrivateIPv4(url.hostname)) throw new Error(`${name} HTTP test URL must use a private IPv4 address`)
  return url.href
}

export type SkillMarketConfig = ReturnType<typeof loadConfig>
