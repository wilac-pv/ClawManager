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

export function docsURL() {
  return env("DOCS_URL")
}

export function supportURL() {
  return env("SUPPORT_URL")
}

export * as Brand from "./brand"
