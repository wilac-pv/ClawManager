import { randomUUID } from "node:crypto"
import { cp, lstat, mkdir, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

export async function run(input: { pairs: Array<{ legacy: string; current: string }>; marker: string }) {
  const marker = path.resolve(input.marker)
  if ((await clearMarker(marker)) === "complete") return { copied: [], skipped: [] }
  const copied: string[] = []
  const skipped: string[] = []
  for (const pair of input.pairs) {
    await mkdir(pair.current, { recursive: true })
    const entries = await readdir(pair.legacy, { withFileTypes: true }).catch((error) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return []
      throw error
    })
    for (const entry of entries) {
      await copyMissing(
        path.join(pair.legacy, entry.name),
        path.join(pair.current, entry.name),
        entry.isDirectory(),
        copied,
        skipped,
        marker,
      )
    }
  }
  await writeMarker(marker, { version: 1, copied, skipped })
  return { copied, skipped }
}

async function copyMissing(
  legacy: string,
  current: string,
  directory: boolean,
  copied: string[],
  skipped: string[],
  marker: string,
) {
  if (path.resolve(current) === marker) {
    skipped.push(legacy)
    return
  }
  const target = await fileInfo(current)
  if (!directory) {
    if (target) {
      skipped.push(legacy)
      return
    }
    await cp(legacy, current, { force: false, errorOnExist: true })
    copied.push(legacy)
    return
  }
  if (target && !target.isDirectory()) {
    skipped.push(legacy)
    return
  }
  if (!target) {
    await mkdir(current, { recursive: true })
    copied.push(legacy)
  }
  for (const entry of await readdir(legacy, { withFileTypes: true })) {
    await copyMissing(
      path.join(legacy, entry.name),
      path.join(current, entry.name),
      entry.isDirectory(),
      copied,
      skipped,
      marker,
    )
  }
}

async function writeMarker(marker: string, data: { version: number; copied: string[]; skipped: string[] }) {
  await mkdir(path.dirname(marker), { recursive: true })
  const temporary = path.join(path.dirname(marker), `.${path.basename(marker)}.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(data, null, 2), { flag: "wx" })
    .then(async () => {
      if ((await clearMarker(marker)) === "complete") {
        await rm(temporary, { force: true })
        return
      }
      await rename(temporary, marker).catch(async (error) => {
        if (!markerCollision(error)) throw error
        if ((await clearMarker(marker)) === "complete") {
          await rm(temporary, { force: true })
          return
        }
        await rename(temporary, marker)
      })
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
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
    throw error
  })
}

function markerCollision(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return error.code === "EEXIST" || error.code === "EISDIR" || error.code === "ENOTEMPTY" || error.code === "EPERM"
}

export * as OemMigration from "./oem"
