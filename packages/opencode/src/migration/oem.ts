import { randomUUID } from "node:crypto"
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Brand } from "@opencode-ai/core/brand/brand"

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
}): Promise<MigrationResult> {
  const marker = path.resolve(input.marker)
  const lock = path.resolve(input.lock ?? `${marker}.lock`)
  return withMigrationLock(lock, async () => {
    if ((await clearMarker(marker)) === "complete") return { copied: [], skipped: [] }
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
          new Set([marker, lock]),
        )
      }
    }
    await writeMarker(marker, { version: 1, copied, skipped })
    return { copied, skipped }
  })
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

async function withMigrationLock<A>(lock: string, task: () => Promise<A>) {
  await mkdir(path.dirname(lock), { recursive: true })
  const owner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() }
  const deadline = Date.now() + 60_000
  while (!(await claimLock(lock, owner))) {
    if (await recoverAbandonedLock(lock)) continue
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for OEM migration lock: ${lock}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return task().finally(() => releaseLock(lock, owner.token))
}

async function claimLock(lock: string, owner: { pid: number; token: string; createdAt: number }) {
  const handle = await open(lock, "wx", 0o600).catch((error) => {
    if (errorCode(error) === "EEXIST") return
    throw error
  })
  if (!handle) return false
  await handle
    .writeFile(JSON.stringify(owner))
    .finally(() => handle.close())
    .catch(async (error) => {
      await unlink(lock).catch(() => undefined)
      throw error
    })
  return true
}

async function recoverAbandonedLock(lock: string) {
  const info = await fileInfo(lock)
  if (!info) return true
  if (!info.isFile()) {
    if (info.isDirectory()) await rmdir(lock)
    else await unlink(lock)
    return true
  }
  const owner = await readFile(lock, "utf8")
    .then((value) => JSON.parse(value) as unknown)
    .catch(() => undefined)
  if (isLockOwner(owner) && processAlive(owner.pid)) return false
  if (!isLockOwner(owner) && Date.now() - info.mtimeMs < 60_000) return false
  await unlink(lock).catch((error) => {
    if (errorCode(error) !== "ENOENT") throw error
  })
  return true
}

async function releaseLock(lock: string, token: string) {
  const owner = await readFile(lock, "utf8")
    .then((value) => JSON.parse(value) as unknown)
    .catch(() => undefined)
  if (!isLockOwner(owner) || owner.token !== token) return
  await unlink(lock).catch((error) => {
    if (errorCode(error) !== "ENOENT") throw error
  })
}

function processAlive(pid: number) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

function isLockOwner(value: unknown): value is { pid: number; token: string; createdAt: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "token" in value &&
    typeof value.token === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "number"
  )
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
  if (target.isFile()) return "complete" as const
  if (target.isDirectory()) {
    await rmdir(marker)
    return "cleared" as const
  }
  await unlink(marker)
  return "cleared" as const
}

function fileInfo(file: string) {
  return lstat(file).catch((error) => {
    if (errorCode(error) === "ENOENT") return
    throw error
  })
}

function temporaryPath(file: string) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
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
