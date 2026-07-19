import { chmod, copyFile, mkdir, readdir, realpath, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageDirectory = fileURLToPath(new URL("..", import.meta.url))
const entrypoints = [
  "src/server.ts",
  "src/sync.ts",
  "src/skillhub-worker.js",
  "src/worker.ts",
  "script/backup.ts",
  "script/cleanup.ts",
  "script/deploy-check.ts",
  "script/migrate.ts",
  "script/restore-drill.ts",
]

export async function buildRelease(outputDirectory: string) {
  const runtimeDirectory = join(outputDirectory, "packages/skill-market-server")
  await rm(outputDirectory, { force: true, recursive: true })
  await mkdir(runtimeDirectory, { recursive: true })
  await Promise.all(entrypoints.map((entrypoint) => buildEntrypoint(entrypoint, runtimeDirectory)))
  await Promise.all(
    ["deploy", "migrations"].map((directory) =>
      copyDirectory(join(packageDirectory, directory), join(runtimeDirectory, directory)),
    ),
  )
  await copyFile(join(packageDirectory, "package.json"), join(runtimeDirectory, "package.json"))
  await copyDirectory(
    await realpath(join(packageDirectory, "node_modules/esprima")),
    join(runtimeDirectory, "node_modules/esprima"),
  )
  await setPermissions(outputDirectory)
}

async function buildEntrypoint(entrypoint: string, runtimeDirectory: string) {
  const result = await Bun.build({
    entrypoints: [join(packageDirectory, entrypoint)],
    target: "bun",
    sourcemap: "none",
  })
  if (!result.success)
    throw new AggregateError(
      result.logs.map((log) => new Error(log.message)),
      `Failed to build ${entrypoint}`,
    )
  if (result.outputs.length !== 1) throw new Error(`Expected one build output for ${entrypoint}`)
  await mkdir(dirname(join(runtimeDirectory, entrypoint)), { recursive: true })
  await Bun.write(join(runtimeDirectory, entrypoint), result.outputs[0])
}

async function copyDirectory(source: string, destination: string) {
  await mkdir(destination, { recursive: true })
  await Promise.all(
    (await readdir(source, { withFileTypes: true })).map((entry) => {
      if (entry.isDirectory()) return copyDirectory(join(source, entry.name), join(destination, entry.name))
      if (entry.isFile()) return copyFile(join(source, entry.name), join(destination, entry.name))
      throw new Error(`Release input contains unsupported entry: ${join(source, entry.name)}`)
    }),
  )
}

async function setPermissions(directory: string) {
  await chmod(directory, 0o755)
  await Promise.all(
    (await readdir(directory, { withFileTypes: true })).map((entry) =>
      entry.isDirectory() ? setPermissions(join(directory, entry.name)) : chmod(join(directory, entry.name), 0o644),
    ),
  )
}

if (import.meta.main) {
  if (!Bun.argv[2]) throw new Error("Usage: bun script/build-release.ts <output-directory>")
  const outputDirectory = resolve(Bun.argv[2])
  await buildRelease(outputDirectory)
  console.log(outputDirectory)
}
