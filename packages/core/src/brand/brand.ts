export interface Profile {
  displayName: string
  englishName: string
  cliName: string
  legacyCliName: string
  packageName: string
  storageName: string
  legacyStorageName: string
  projectDirectory: string
  legacyProjectDirectory: string
  providerID: string
}

export const profile = {
  displayName: "如影 Code",
  englishName: "Ruying Code",
  cliName: "ruying-code",
  legacyCliName: "opencode",
  packageName: "@ruying/ruying-code",
  storageName: "ruying-code",
  legacyStorageName: "opencode",
  projectDirectory: ".ruying-code",
  legacyProjectDirectory: ".opencode",
  providerID: "ruying",
} satisfies Profile

export function env(suffix: string) {
  return process.env[`RUYING_CODE_${suffix}`] ?? process.env[`OPENCODE_${suffix}`]
}

export function truthy(suffix: string) {
  const value = env(suffix)?.toLowerCase()
  return value === "true" || value === "1"
}

function url(suffix: string) {
  const value = env(suffix)
  if (!value || Buffer.byteLength(value, "utf8") > 512) return
  if (/[\u0000-\u0020\u007f\u2028\u2029]/u.test(value)) return
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return
    return value
  } catch {
    return
  }
}

export function docsURL() {
  return url("DOCS_URL")
}

export function supportURL() {
  return url("SUPPORT_URL")
}

export function changelogURL() {
  return env("CHANGELOG_URL")
}

export * as Brand from "./brand"
