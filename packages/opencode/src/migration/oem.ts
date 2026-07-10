import { cp, lstat, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

export async function run(input: { pairs: Array<{ legacy: string; current: string }>; marker: string }) {
  if (await Bun.file(input.marker).exists()) return { copied: [], skipped: [] }
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
      )
    }
  }
  await mkdir(path.dirname(input.marker), { recursive: true })
  await writeFile(input.marker, JSON.stringify({ version: 1, copied, skipped }, null, 2))
  return { copied, skipped }
}

async function copyMissing(legacy: string, current: string, directory: boolean, copied: string[], skipped: string[]) {
  const target = await lstat(current).catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
    throw error
  })
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
    )
  }
}

export * as OemMigration from "./oem"
