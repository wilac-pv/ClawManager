import { app } from "electron"
import log from "electron-log/main.js"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CHANNEL } from "./constants"
import { getStore } from "./store"

const TAURI_MIGRATED_KEY = "tauriMigrated"
const LEGACY_ELECTRON_MIGRATED_FILE = ".legacy-electron-migrated"

const LEGACY_APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

const RUYING_APP_IDS = {
  dev: "cn.gwm.ruying-code.dev",
  beta: "cn.gwm.ruying-code.beta",
  prod: "cn.gwm.ruying-code",
} as const

// Resolve the directory where Tauri stored its .dat files for the given app identifier.
// Mirrors Tauri's AppLocalData / AppData resolution per OS.
function tauriDir(id: string) {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", id)
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), id)
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), id)
  }
}

// The Tauri app identifier changes between dev/beta/prod builds.
const TAURI_APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
function tauriAppId() {
  return app.isPackaged ? TAURI_APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
}

export function migrateLegacyElectronData(legacyDir: string, currentDir: string) {
  const marker = join(currentDir, LEGACY_ELECTRON_MIGRATED_FILE)
  if (existsSync(marker)) return

  mkdirSync(currentDir, { recursive: true })
  if (existsSync(legacyDir)) {
    readdirSync(legacyDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (entry.name === "default.dat" || entry.name.startsWith("opencode.")))
      .forEach((entry) => migrateLegacyElectronStore(join(legacyDir, entry.name), join(currentDir, entry.name)))
  }

  writeJsonAtomically(marker, { migratedAt: new Date().toISOString() })
}

function migrateLegacyElectronStore(legacyFile: string, currentFile: string) {
  const legacy = readObject(legacyFile)
  const current = existsSync(currentFile) ? readObject(currentFile) : {}

  const missing = Object.fromEntries(Object.entries(legacy).filter(([key]) => !(key in current)))
  if (Object.keys(missing).length === 0) return
  writeJsonAtomically(currentFile, { ...current, ...missing })
}

function readObject(file: string) {
  const value = JSON.parse(readFileSync(file, "utf8")) as unknown
  if (!isRecord(value)) {
    throw new Error(`legacy electron migration: store is not an object ${file}`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function writeJsonAtomically(file: string, value: Record<string, unknown>) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2))
  renameSync(temporary, file)
}

// Migrate a single Tauri .dat file into the corresponding electron-store.
// `opencode.settings.dat` is special: it maps to the `opencode.settings` store
// (the electron-store name without the `.dat` extension). All other .dat files
// keep their full filename as the electron-store name so they match what the
// renderer already passes via IPC (e.g. `"default.dat"`, `"opencode.global.dat"`).
function migrateFile(datPath: string, filename: string) {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(readFileSync(datPath, "utf-8"))
  } catch (err) {
    log.warn("tauri migration: failed to parse", filename, err)
    return
  }

  // opencode.settings.dat → the electron settings store ("opencode.settings").
  // All other .dat files keep their full filename as the store name so they match
  // what the renderer passes via IPC (e.g. "default.dat", "opencode.global.dat").
  const storeName = filename === "opencode.settings.dat" ? "opencode.settings" : filename
  const target = getStore(storeName)
  const migrated: string[] = []
  const skipped: string[] = []

  for (const [key, value] of Object.entries(data)) {
    // Don't overwrite values the user has already set in the Electron app.
    if (target.has(key)) {
      skipped.push(key)
      continue
    }
    target.set(key, value)
    migrated.push(key)
  }

  log.log("tauri migration: migrated", filename, "→", storeName, { migrated, skipped })
}

export function migrate() {
  const channel = app.isPackaged ? CHANNEL : "dev"
  try {
    migrateLegacyElectronData(
      join(app.getPath("appData"), LEGACY_APP_IDS[channel]),
      join(app.getPath("appData"), RUYING_APP_IDS[channel]),
    )
  } catch (error) {
    log.warn("legacy electron migration: failed", error)
  }

  if (getStore().get(TAURI_MIGRATED_KEY)) {
    log.log("tauri migration: already done, skipping")
    return
  }

  const dir = tauriDir(tauriAppId())
  log.log("tauri migration: starting", { dir })

  if (!existsSync(dir)) {
    log.log("tauri migration: no tauri data directory found, nothing to migrate")
    getStore().set(TAURI_MIGRATED_KEY, true)
    return
  }

  for (const filename of readdirSync(dir)) {
    if (!filename.endsWith(".dat")) continue
    migrateFile(join(dir, filename), filename)
  }

  log.log("tauri migration: complete")
  getStore().set(TAURI_MIGRATED_KEY, true)
}
