#!/usr/bin/env bun

import { $ } from "bun"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { fileURLToPath } from "url"

export function isolatedEnvironment(
  root: string,
  host: Record<string, string | undefined>,
  platform = process.platform,
) {
  const executablePath = host.PATH ?? host.Path
  if (!executablePath) throw new Error("Package verification requires PATH to find npm, node, and the installed bins")

  return {
    PATH: executablePath,
    LANG: host.LANG ?? "C",
    CI: "1",
    NO_COLOR: "1",
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    TMPDIR: path.join(root, "temp"),
    TEMP: path.join(root, "temp"),
    TMP: path.join(root, "temp"),
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_userconfig: path.join(root, "npmrc"),
    npm_config_globalconfig: path.join(root, "global-npmrc"),
    npm_config_registry: "http://127.0.0.1:9/",
    npm_config_offline: "true",
    npm_config_loglevel: "error",
    npm_config_fetch_retries: "0",
    npm_config_fetch_timeout: "1000",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    ...(platform === "win32" && (host.SystemRoot ?? host.SYSTEMROOT)
      ? { SystemRoot: host.SystemRoot ?? host.SYSTEMROOT }
      : {}),
    ...(platform === "win32" && host.ComSpec ? { ComSpec: host.ComSpec } : {}),
    ...(platform === "win32" && host.PATHEXT ? { PATHEXT: host.PATHEXT } : {}),
    ...(platform === "win32" && host.WINDIR ? { WINDIR: host.WINDIR } : {}),
  }
}

type WrapperManifest = {
  name: string
  version: string
  scripts?: { postinstall?: string }
}

export function packageInstallArguments(platformTarball: string, wrapperTarball: string) {
  return ["install", "--offline", "--no-audit", "--no-fund", "--foreground-scripts", platformTarball, wrapperTarball]
}

export function requirePostinstall(manifest: WrapperManifest) {
  if (manifest.scripts?.postinstall !== "node ./postinstall.mjs") {
    throw new Error(`Packed ${manifest.name} wrapper must declare postinstall as "node ./postinstall.mjs"`)
  }
  return manifest.scripts.postinstall
}

export function requireLifecycleEvidence(output: string, manifest: WrapperManifest) {
  const command = requirePostinstall(manifest)
  if (output.includes(`> ${manifest.name}@${manifest.version} postinstall`) && output.includes(`> ${command}`)) return
  throw new Error(`npm did not report running ${manifest.name}@${manifest.version} postinstall:\n${output.trim()}`)
}

async function main() {
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
          scripts?: { postinstall?: string }
          os?: string[]
          cpu?: string[]
          libc?: string[]
        },
        directory: packageDirectory,
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
  requirePostinstall(wrapper.manifest)

  // Node canonicalizes import.meta.url, so use the real temp path to keep direct lifecycle execution comparable on macOS.
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "ruying-package-"))
  const env = isolatedEnvironment(root, process.env)

  try {
    await Promise.all([mkdir(env.HOME, { recursive: true }), mkdir(env.TMPDIR, { recursive: true })])
    await writeFile(env.npm_config_globalconfig, "")
    await writeFile(
      env.npm_config_userconfig,
      ["registry=http://127.0.0.1:9/", "offline=true", "audit=false", "fund=false", "update-notifier=false", ""].join(
        "\n",
      ),
    )

    const init = await $`npm init -y`.cwd(root).env(env).quiet().nothrow()
    if (init.exitCode !== 0) {
      throw new Error(`Failed to initialize isolated npm project:\n${init.stderr.toString().trim()}`)
    }

    const install = await $`npm ${packageInstallArguments(platform.tarball, wrapper.tarball)}`
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
    const installedManifest = (await Bun.file(path.join(wrapperDirectory, "package.json")).json()) as WrapperManifest
    requireLifecycleEvidence(install.stdout.toString(), installedManifest)
    if (installedManifest.name !== wrapper.manifest.name || installedManifest.version !== wrapper.manifest.version) {
      throw new Error(
        `Installed wrapper identity differs: expected ${wrapper.manifest.name}@${wrapper.manifest.version}, found ${installedManifest.name}@${installedManifest.version}`,
      )
    }
    const launcher = path.join(wrapperDirectory, "bin", "ruying-code")
    const nativePath = path.join(
      wrapperDirectory,
      "bin",
      process.platform === "win32" ? "ruying-code-native.exe" : "ruying-code-native",
    )
    if (!(await Bun.file(nativePath).exists())) {
      throw new Error(`npm postinstall did not create the wrapper-local native binary at ${nativePath}`)
    }
    if (
      (await Bun.file(launcher).text()) !== (await Bun.file(path.join(wrapper.directory, "bin", "ruying-code")).text())
    ) {
      throw new Error(`npm postinstall replaced the packed Node launcher at ${launcher}`)
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
    const native = await $`${nativePath} --version`.cwd(root).env(env).quiet().nothrow()
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
}

if (import.meta.main) await main()
