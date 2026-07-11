#!/usr/bin/env bun

import { $ } from "bun"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { fileURLToPath } from "url"

const directory = fileURLToPath(new URL("..", import.meta.url))
const dist = path.join(directory, "dist")
const packages = await Promise.all(
  Array.from(new Bun.Glob("*/package.json").scanSync({ cwd: dist })).map(async (filepath) => {
    const packageDirectory = path.join(dist, path.dirname(filepath))
    const tarballs = Array.from(new Bun.Glob("*.tgz").scanSync({ cwd: packageDirectory }))
    if (tarballs.length !== 1) {
      throw new Error(
        `Expected one packed tarball in ${packageDirectory}, found ${tarballs.length}; run bun run script/publish-ruying.ts --pack-only first`,
      )
    }
    return {
      manifest: (await Bun.file(path.join(dist, filepath)).json()) as {
        name: string
        version: string
        os?: string[]
        cpu?: string[]
        libc?: string[]
      },
      tarball: path.join(packageDirectory, tarballs[0]),
    }
  }),
)
const wrapper = packages.find((entry) => entry.manifest.name === "@ruying/ruying-code")
if (!wrapper) {
  throw new Error(`Packed @ruying/ruying-code wrapper not found under ${dist}; run the pack-only publisher first`)
}

const ldd = process.platform === "linux" ? Bun.spawnSync(["ldd", "--version"]) : undefined
const musl =
  process.platform === "linux" &&
  ((await Bun.file("/etc/alpine-release").exists()) ||
    `${ldd?.stdout.toString() ?? ""}${ldd?.stderr.toString() ?? ""}`.toLowerCase().includes("musl"))
const platform = packages
  .filter(
    (entry) =>
      entry.manifest.name.startsWith("@ruying/ruying-code-") &&
      entry.manifest.os?.includes(process.platform) &&
      entry.manifest.cpu?.includes(process.arch) &&
      (process.platform !== "linux"
        ? entry.manifest.libc === undefined
        : musl
          ? entry.manifest.libc?.includes("musl")
          : entry.manifest.libc === undefined),
  )
  .sort((a, b) => Number(b.manifest.name.includes("-baseline")) - Number(a.manifest.name.includes("-baseline")))[0]
if (!platform) {
  throw new Error(
    `Packed platform package not found for ${process.platform}/${process.arch}${musl ? "/musl" : ""} under ${dist}; build the current platform and run the pack-only publisher first`,
  )
}
if (platform.manifest.version !== wrapper.manifest.version) {
  throw new Error(
    `Packed package versions differ: ${wrapper.manifest.name}@${wrapper.manifest.version} and ${platform.manifest.name}@${platform.manifest.version}`,
  )
}

// Node canonicalizes import.meta.url, so use the real temp path to keep direct lifecycle execution comparable on macOS.
const root = await mkdtemp(path.join(await realpath(tmpdir()), "ruying-package-"))
const home = path.join(root, "home")
const npmrc = path.join(root, "npmrc")
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  APPDATA: path.join(root, "appdata"),
  LOCALAPPDATA: path.join(root, "localappdata"),
  NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
  NPM_CONFIG_USERCONFIG: npmrc,
  NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
  NPM_CONFIG_OFFLINE: "true",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
}

try {
  await mkdir(home, { recursive: true })
  await writeFile(
    npmrc,
    [
      "registry=http://127.0.0.1:9/",
      "offline=true",
      "audit=false",
      "fund=false",
      "update-notifier=false",
      "ignore-scripts=true",
      "",
    ].join("\n"),
  )

  const init = await $`npm init -y`.cwd(root).env(env).quiet().nothrow()
  if (init.exitCode !== 0) {
    throw new Error(`Failed to initialize isolated npm project:\n${init.stderr.toString().trim()}`)
  }

  const install =
    await $`npm install --ignore-scripts --offline --no-audit --no-fund ${platform.tarball} ${wrapper.tarball}`
      .cwd(root)
      .env(env)
      .quiet()
      .nothrow()
  if (install.exitCode !== 0) {
    throw new Error(
      `Failed to install local tarballs for ${wrapper.manifest.name} and ${platform.manifest.name}:\n${install.stderr.toString().trim()}`,
    )
  }

  const wrapperDirectory = path.join(root, "node_modules", "@ruying", "ruying-code")
  const postinstall = await $`node ${path.join(wrapperDirectory, "postinstall.mjs")}`
    .cwd(root)
    .env(env)
    .quiet()
    .nothrow()
  if (postinstall.exitCode !== 0) {
    throw new Error(`Local wrapper failed to resolve its native binary:\n${postinstall.stderr.toString().trim()}`)
  }

  const suffix = process.platform === "win32" ? ".cmd" : ""
  const primary = await $`${path.join(root, "node_modules", ".bin", `ruying-code${suffix}`)} --version`
    .cwd(root)
    .env(env)
    .quiet()
    .nothrow()
  if (primary.exitCode !== 0) {
    throw new Error(`Installed ruying-code --version failed:\n${primary.stderr.toString().trim()}`)
  }
  const legacy = await $`${path.join(root, "node_modules", ".bin", `opencode${suffix}`)} --version`
    .cwd(root)
    .env(env)
    .quiet()
    .nothrow()
  if (legacy.exitCode !== 0) {
    throw new Error(`Installed opencode --version failed:\n${legacy.stderr.toString().trim()}`)
  }
  const native = await $`${path.join(
    wrapperDirectory,
    "bin",
    process.platform === "win32" ? "ruying-code-native.exe" : "ruying-code-native",
  )} --version`
    .cwd(root)
    .env(env)
    .quiet()
    .nothrow()
  if (native.exitCode !== 0) {
    throw new Error(`Resolved native binary --version failed:\n${native.stderr.toString().trim()}`)
  }

  const versions = [primary, legacy, native].map((result) => result.stdout.toString().trim())
  if (versions.some((version) => version !== wrapper.manifest.version)) {
    throw new Error(
      `Installed versions differ: ruying-code=${versions[0] || "<empty>"}, opencode=${versions[1] || "<empty>"}, native=${versions[2] || "<empty>"}, package=${wrapper.manifest.version}`,
    )
  }

  console.log(`ruying-code --version: ${versions[0]}`)
  console.log(`opencode --version: ${versions[1]}`)
  console.log(`native --version: ${versions[2]} (${platform.manifest.name})`)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
