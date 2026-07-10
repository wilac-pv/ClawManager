import { cp, mkdir, readdir, writeFile } from "node:fs/promises"
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
      const target = path.join(pair.current, entry.name)
      if (await Bun.file(target).exists()) {
        skipped.push(`${pair.legacy}/${entry.name}`)
        continue
      }
      await cp(path.join(pair.legacy, entry.name), target, { recursive: entry.isDirectory(), errorOnExist: true })
      copied.push(`${pair.legacy}/${entry.name}`)
    }
  }
  await mkdir(path.dirname(input.marker), { recursive: true })
  await writeFile(input.marker, JSON.stringify({ version: 1, copied, skipped }, null, 2))
  return { copied, skipped }
}

export * as OemMigration from "./oem"
