#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import semver from "semver"
import { fileURLToPath } from "url"

export const INSTALL_REGISTRY = "https://nexus.gwm.cn/repository/npm-group/"
export const PUBLISH_REGISTRY = "https://nexus.gwm.cn/repository/npm-releases/"

export type PlatformTarget = {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

export type PlatformPackageManifest = {
  name: string
  version: string
  preferUnplugged?: boolean
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

export const SUPPORTED_TARGETS: PlatformTarget[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

export function platformDirectory(target: PlatformTarget) {
  return [
    "ruying-code",
    target.os === "win32" ? "windows" : target.os,
    target.arch,
    target.avx2 === false ? "baseline" : undefined,
    target.abi,
  ]
    .filter((part) => part !== undefined)
    .join("-")
}

export function platformManifest(version: string, target: PlatformTarget) {
  return {
    name: `@ruying/${platformDirectory(target)}`,
    version,
    preferUnplugged: true,
    os: [target.os],
    cpu: [target.arch],
    ...(target.abi ? { libc: [target.abi] } : {}),
  }
}

export function releaseArtifact(target: PlatformTarget) {
  const directory = platformDirectory(target)
  return {
    directory,
    archive: `${directory}.${target.os === "linux" ? "tar.gz" : "zip"}`,
  }
}

export function wrapperManifest(
  version: string,
  optionalDependencies: Record<string, string>,
  compatibility = { os: ["darwin", "linux", "win32"], cpu: ["arm64", "x64"] },
) {
  return {
    name: "@ruying/ruying-code",
    version,
    bin: { "ruying-code": "./bin/ruying-code", opencode: "./bin/ruying-code" },
    scripts: { postinstall: "node ./postinstall.mjs" },
    optionalDependencies,
    os: compatibility.os,
    cpu: compatibility.cpu,
  }
}

export function launcherSource() {
  return [
    "#!/usr/bin/env node",
    'import("../postinstall.mjs")',
    "  .then((module) => module.launch(process.argv.slice(2)))",
    "  .catch((error) => {",
    "    console.error(error.message)",
    "    process.exit(1)",
    "  })",
    "",
  ].join("\n")
}

export function platformDependencies(manifests: Array<{ name: string; version: string }>) {
  return Object.fromEntries(
    manifests
      .filter((manifest) => manifest.name.startsWith("@ruying/ruying-code-"))
      .map((manifest) => [manifest.name, manifest.version]),
  )
}

export function packagePlan(manifests: PlatformPackageManifest[], packOnly: boolean) {
  if (manifests.length === 0) throw new Error("No @ruying/ruying-code platform packages found; run the build first")
  const versions = [...new Set(manifests.map((manifest) => manifest.version))]
  if (versions.length !== 1) throw new Error(`Platform package versions differ: ${versions.join(", ")}`)

  const targets = manifests.map((manifest) => {
    const target = SUPPORTED_TARGETS.find(
      (candidate) => platformManifest(manifest.version, candidate).name === manifest.name,
    )
    if (!target) throw new Error(`Unexpected platform package: ${manifest.name}`)
    const expected = platformManifest(manifest.version, target)
    if (
      manifest.preferUnplugged !== expected.preferUnplugged ||
      JSON.stringify(manifest.os) !== JSON.stringify(expected.os) ||
      JSON.stringify(manifest.cpu) !== JSON.stringify(expected.cpu) ||
      JSON.stringify(manifest.libc) !== JSON.stringify("libc" in expected ? expected.libc : undefined)
    ) {
      throw new Error(`Malformed platform package: ${manifest.name}`)
    }
    return target
  })
  if (new Set(manifests.map((manifest) => manifest.name)).size !== manifests.length) {
    throw new Error("Unexpected platform package: duplicate package name")
  }
  if (!packOnly && manifests.length !== SUPPORTED_TARGETS.length) {
    throw new Error(
      `Real publishing requires the complete supported platform set (${SUPPORTED_TARGETS.length} packages)`,
    )
  }

  return {
    version: versions[0],
    optionalDependencies: platformDependencies(manifests),
    os: ["darwin", "linux", "win32"].filter((os) => targets.some((target) => target.os === os)),
    cpu: ["arm64", "x64"].filter((cpu) => targets.some((target) => target.arch === cpu)),
  }
}

export function npmViewArguments(name: string, version: string) {
  return ["view", `${name}@${version}`, "version", `--registry=${INSTALL_REGISTRY}`]
}

export function npmPublishArguments(tarball: string, tag: string) {
  return ["publish", tarball, `--registry=${PUBLISH_REGISTRY}`, "--tag", tag]
}

export function releaseMetadata(
  args: string[],
  env: Record<string, string | undefined>,
  builtVersion: string,
  packOnly: boolean,
) {
  const version =
    argument(args, "--version") ?? env.RUYING_CODE_RELEASE_VERSION ?? (packOnly ? builtVersion : undefined)
  const tag = argument(args, "--tag") ?? env.RUYING_CODE_RELEASE_TAG ?? (packOnly ? "" : undefined)
  if (!version || tag === undefined || (!packOnly && !tag)) {
    throw new Error(
      "Real publishing requires an explicit release version and tag via --version/--tag or RUYING_CODE_RELEASE_VERSION/RUYING_CODE_RELEASE_TAG",
    )
  }
  if (!semver.valid(version)) throw new Error(`Invalid release version: ${version}`)
  if (version !== builtVersion) {
    throw new Error(`Release version ${version} does not match built package version ${builtVersion}`)
  }
  if (tag && (!/^[a-z0-9][a-z0-9._-]*$/.test(tag) || semver.validRange(tag))) {
    throw new Error(`Invalid release tag: ${tag}`)
  }
  return { version, tag }
}

function argument(args: string[], name: string) {
  const inline = args.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  if (index === -1) return
  return args[index + 1]
}

export async function removeTarballs(directory: string) {
  await Promise.all(
    Array.from(new Bun.Glob("*.tgz").scanSync({ cwd: directory })).map((tarball) =>
      Bun.file(path.join(directory, tarball)).delete(),
    ),
  )
}

async function publish(directory: string, name: string, version: string, tag: string, packOnly: boolean) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(directory)
  if (!packOnly) {
    const view = Bun.spawn(["npm", ...npmViewArguments(name, version)], {
      cwd: directory,
      stdout: "ignore",
      stderr: "ignore",
    })
    if ((await view.exited) === 0) {
      console.log(`already published ${name}@${version}`)
      return
    }
  }

  await removeTarballs(directory)
  await $`bun pm pack`.cwd(directory)
  if (packOnly) return

  const tarballs = Array.from(new Bun.Glob("*.tgz").scanSync({ cwd: directory }))
  if (tarballs.length !== 1) throw new Error(`Expected one tarball for ${name}, found ${tarballs.length}`)
  const result = Bun.spawn(["npm", ...npmPublishArguments(tarballs[0], tag)], {
    cwd: directory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await result.exited) !== 0) throw new Error(`Failed to publish ${name}@${version}`)
}

async function main() {
  const dir = fileURLToPath(new URL("..", import.meta.url))
  const dist = path.join(dir, "dist")
  const packOnly = process.argv.includes("--pack-only")
  const packages = await Promise.all(
    Array.from(new Bun.Glob("*/package.json").scanSync({ cwd: dist })).map(async (filepath) => ({
      directory: path.join(dist, path.dirname(filepath)),
      manifest: (await Bun.file(path.join(dist, filepath)).json()) as PlatformPackageManifest,
    })),
  ).then((entries) =>
    entries.filter(
      (entry) => typeof entry.manifest.name === "string" && entry.manifest.name.startsWith("@ruying/ruying-code-"),
    ),
  )
  const plan = packagePlan(
    packages.map((entry) => entry.manifest),
    packOnly,
  )
  const metadata = releaseMetadata(process.argv.slice(2), process.env, plan.version, packOnly)

  const wrapper = path.join(dist, "ruying-code")
  await $`rm -rf ${wrapper}`
  await $`mkdir -p ${path.join(wrapper, "bin")}`
  await $`cp ${path.join(dir, "script", "postinstall.mjs")} ${path.join(wrapper, "postinstall.mjs")}`
  await Bun.file(path.join(wrapper, "LICENSE")).write(await Bun.file(path.join(dir, "..", "..", "LICENSE")).text())
  await Bun.file(path.join(wrapper, "bin", "ruying-code")).write(launcherSource())
  await Bun.file(path.join(wrapper, "package.json")).write(
    JSON.stringify(wrapperManifest(metadata.version, plan.optionalDependencies, plan), null, 2),
  )

  for (const entry of packages) {
    await publish(entry.directory, entry.manifest.name, entry.manifest.version, metadata.tag, packOnly)
  }
  await publish(wrapper, "@ruying/ruying-code", metadata.version, metadata.tag, packOnly)
}

if (import.meta.main) await main()
