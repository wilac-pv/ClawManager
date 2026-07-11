import { randomUUID } from "node:crypto"
import { cp, lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Brand } from "@opencode-ai/core/brand/brand"
import { Flock } from "@opencode-ai/core/util/flock"

type MigrationResult = { copied: string[]; skipped: string[] }

export async function runDefault(input: { legacyStateRoot?: string } = {}) {
  const lock = path.join(Global.Path.state, ".oem-migration-v1.lock")
  const defaults = await run({
    pairs: [Global.Path.config, Global.Path.data, Global.Path.cache, Global.Path.state].map((current) => ({
      legacy: path.join(path.dirname(current), Brand.profile.legacyStorageName),
      current,
    })),
    marker: path.join(Global.Path.state, ".oem-migration-v1.json"),
    lock,
  })
  if (!input.legacyStateRoot) return defaults
  const desktop = await run({
    pairs: [
      {
        legacy: path.join(input.legacyStateRoot, Brand.profile.legacyStorageName),
        current: Global.Path.state,
      },
    ],
    marker: path.join(Global.Path.state, ".oem-desktop-state-migration-v1.json"),
    lock,
  })
  return {
    copied: [...defaults.copied, ...desktop.copied],
    skipped: [...defaults.skipped, ...desktop.skipped],
  }
}

export function run(input: {
  pairs: Array<{ legacy: string; current: string }>
  marker: string
  lock?: string
  lockOptions?: Flock.Options
}): Promise<MigrationResult> {
  const marker = path.resolve(input.marker)
  const lock = path.resolve(input.lock ?? `${marker}.lock`)
  const lockRoot = `${lock}.d`
  return Flock.withLock(
    lock,
    async () => {
      if ((await clearMarker(marker)) === "complete") return { copied: [], skipped: [] }
      const reserved = new Set([marker, lock, lockRoot].map((item) => path.resolve(item)))
      await Promise.all(
        [...new Set([...input.pairs.map((pair) => pair.current), path.dirname(marker)])].map((root) =>
          clearOrphanTemporaries(root, reserved),
        ),
      )
      const copied: string[] = []
      const skipped: string[] = []
      for (const pair of input.pairs) {
        await mkdir(pair.current, { recursive: true })
        const entries = await readdir(pair.legacy, { withFileTypes: true }).catch((error) => {
          if (errorCode(error) === "ENOENT") return []
          throw error
        })
        for (const entry of entries) {
          await copyMissing(
            path.join(pair.legacy, entry.name),
            path.join(pair.current, entry.name),
            entry.isDirectory(),
            copied,
            skipped,
            reserved,
          )
        }
      }
      await writeMarker(marker, { version: 1, copied, skipped })
      return { copied, skipped }
    },
    { ...input.lockOptions, dir: lockRoot },
  )
}

async function copyMissing(
  legacy: string,
  current: string,
  directory: boolean,
  copied: string[],
  skipped: string[],
  reserved: Set<string>,
) {
  if (reserved.has(path.resolve(current))) {
    skipped.push(legacy)
    return
  }
  const target = await fileInfo(current)
  if (!directory) {
    if (target) {
      skipped.push(legacy)
      return
    }
    const temporary = temporaryPath(current)
    await cp(legacy, temporary, { force: false, errorOnExist: true })
      .then(() => publishTemporary(temporary, current, legacy, copied, skipped))
      .catch(async (error) => {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
        throw error
      })
    return
  }
  if (target && !target.isDirectory()) {
    skipped.push(legacy)
    return
  }
  if (!target) {
    const temporary = temporaryPath(current)
    const published = await cp(legacy, temporary, { recursive: true, force: false, errorOnExist: true })
      .then(() => publishTemporary(temporary, current, legacy, copied, skipped))
      .catch(async (error) => {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
        throw error
      })
    if (published) return
  }
  for (const entry of await readdir(legacy, { withFileTypes: true })) {
    await copyMissing(
      path.join(legacy, entry.name),
      path.join(current, entry.name),
      entry.isDirectory(),
      copied,
      skipped,
      reserved,
    )
  }
}

async function publishTemporary(
  temporary: string,
  current: string,
  legacy: string,
  copied: string[],
  skipped: string[],
) {
  return rename(temporary, current)
    .then(() => {
      copied.push(legacy)
      return true
    })
    .catch(async (error) => {
      if (!copyCollision(error) || !(await fileInfo(current))) throw error
      await rm(temporary, { recursive: true, force: true })
      skipped.push(legacy)
      return false
    })
}

async function writeMarker(marker: string, data: { version: number; copied: string[]; skipped: string[] }) {
  await mkdir(path.dirname(marker), { recursive: true })
  const temporary = temporaryPath(marker)
  await writeFile(temporary, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 })
    .then(async () => {
      await clearMarker(marker)
      await rename(temporary, marker)
    })
    .catch(async (error) => {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    })
}

async function clearMarker(marker: string) {
  const target = await fileInfo(marker)
  if (!target) return "missing" as const
  if (target.isFile()) {
    const value = await readFile(marker, "utf8")
      .then((content) => JSON.parse(content) as unknown)
      .catch(() => undefined)
    if (isMarker(value)) return "complete" as const
    await unlink(marker)
    return "cleared" as const
  }
  if (target.isDirectory()) {
    await rmdir(marker)
    return "cleared" as const
  }
  await unlink(marker)
  return "cleared" as const
}

async function clearOrphanTemporaries(root: string, reserved: Set<string>) {
  const target = await fileInfo(root)
  if (!target?.isDirectory()) return
  await Promise.all(
    (await readdir(root, { withFileTypes: true })).map(async (entry) => {
      const current = path.join(root, entry.name)
      if (reserved.has(path.resolve(current))) return
      if (isTemporaryName(entry.name)) {
        await rm(current, { recursive: true, force: true })
        return
      }
      if (entry.isDirectory()) await clearOrphanTemporaries(current, reserved)
    }),
  )
}

function isMarker(value: unknown): value is { version: 1; copied: string[]; skipped: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "copied" in value &&
    Array.isArray(value.copied) &&
    value.copied.every((item) => typeof item === "string") &&
    "skipped" in value &&
    Array.isArray(value.skipped) &&
    value.skipped.every((item) => typeof item === "string")
  )
}

function isTemporaryName(name: string) {
  return /^\.ruying-oem-migration-v1\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(
    name,
  )
}

function fileInfo(file: string) {
  return lstat(file).catch((error) => {
    if (errorCode(error) === "ENOENT") return
    throw error
  })
}

function temporaryPath(file: string) {
  return path.join(path.dirname(file), `.ruying-oem-migration-v1.${process.pid}.${randomUUID()}.tmp`)
}

function copyCollision(error: unknown) {
  const code = errorCode(error)
  return code === "EEXIST" || code === "EISDIR" || code === "ENOTEMPTY" || code === "EPERM"
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return
  return error.code
}

export * as OemMigration from "./oem"
