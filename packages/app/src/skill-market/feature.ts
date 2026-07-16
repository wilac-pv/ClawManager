export function isSkillMarketEnabled(value = import.meta.env.VITE_RUYING_SKILL_MARKET_ENABLED) {
  return value !== "false"
}

export function skillMarketSubmissionUrl(
  value = import.meta.env.VITE_RUYING_SKILL_MARKET_WEB_URL,
  allowInsecurePrivateHttp = import.meta.env.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP === "true",
) {
  if (!value || !URL.canParse(value)) return undefined
  const url = new URL(value)
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  const privateHttp = url.protocol === "http:" && allowInsecurePrivateHttp && privateIpv4(url.hostname)
  if (url.protocol !== "https:" && !loopback && !privateHttp) return undefined
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/submissions/new`
  url.search = ""
  url.hash = ""
  return url.toString()
}

export const skillMarketEnabled = isSkillMarketEnabled()

function privateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) return true
  return parts[0] === 192 && parts[1] === 168
}
