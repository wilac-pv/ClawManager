#!/usr/bin/env bun

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"

export const INSTALL_REGISTRY = "https://nexus.gwm.cn/repository/npm-group/"
export const PUBLISH_REGISTRY = "https://nexus.gwm.cn/repository/npm-releases/"

export type PlatformTarget = {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}

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

export function wrapperManifest(version: string, optionalDependencies: Record<string, string>) {
  return {
    name: "@ruying/ruying-code",
    version,
    bin: { "ruying-code": "./bin/ruying-code", opencode: "./bin/ruying-code" },
    scripts: { postinstall: "node ./postinstall.mjs" },
    optionalDependencies,
    os: ["darwin", "linux", "win32"],
    cpu: ["arm64", "x64"],
  }
}

export function platformDependencies(manifests: Array<{ name: string; version: string }>) {
  return Object.fromEntries(
    manifests
      .filter((manifest) => manifest.name.startsWith("@ruying/ruying-code-"))
      .map((manifest) => [manifest.name, manifest.version]),
  )
}

export function npmViewArguments(name: string, version: string) {
  return ["view", `${name}@${version}`, "version", `--registry=${INSTALL_REGISTRY}`]
}

export function npmPublishArguments(tarball: string, tag: string) {
  return ["publish", tarball, `--registry=${PUBLISH_REGISTRY}`, "--tag", tag]
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
  const { Script } = await import("@opencode-ai/script")
  const dir = fileURLToPath(new URL("..", import.meta.url))
  const dist = path.join(dir, "dist")
  const packages = await Promise.all(
    Array.from(new Bun.Glob("*/package.json").scanSync({ cwd: dist })).map(async (filepath) => ({
      directory: path.join(dist, path.dirname(filepath)),
      manifest: (await Bun.file(path.join(dist, filepath)).json()) as { name: string; version: string },
    })),
  ).then((entries) => entries.filter((entry) => entry.manifest.name.startsWith("@ruying/ruying-code-")))

  if (packages.length === 0) throw new Error("No @ruying/ruying-code platform packages found; run the build first")
  const versions = [...new Set(packages.map((entry) => entry.manifest.version))]
  if (versions.length !== 1) throw new Error(`Platform package versions differ: ${versions.join(", ")}`)

  const wrapper = path.join(dist, "ruying-code")
  await $`rm -rf ${wrapper}`
  await $`mkdir -p ${path.join(wrapper, "bin")}`
  await $`cp ${path.join(dir, "script", "postinstall.mjs")} ${path.join(wrapper, "postinstall.mjs")}`
  await Bun.file(path.join(wrapper, "LICENSE")).write(await Bun.file(path.join(dir, "..", "..", "LICENSE")).text())
  await Bun.file(path.join(wrapper, "bin", "ruying-code")).write(
    [
      "#!/bin/sh",
      'echo "Error: @ruying/ruying-code postinstall script was not run." >&2',
      'echo "Run node node_modules/@ruying/ruying-code/postinstall.mjs or reinstall without --ignore-scripts." >&2',
      "exit 1",
      "",
    ].join("\n"),
  )
  const dependencies = platformDependencies(packages.map((entry) => entry.manifest))
  await Bun.file(path.join(wrapper, "package.json")).write(JSON.stringify(wrapperManifest(versions[0], dependencies), null, 2))

  const packOnly = process.argv.includes("--pack-only")
  for (const entry of packages) {
    await publish(entry.directory, entry.manifest.name, entry.manifest.version, Script.channel, packOnly)
  }
  await publish(wrapper, "@ruying/ruying-code", versions[0], Script.channel, packOnly)
}

if (import.meta.main) await main()
