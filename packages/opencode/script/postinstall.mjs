#!/usr/bin/env node

import childProcess from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { createRequire } from "module"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
}
const archMap = {
  x64: "x64",
  arm64: "arm64",
  arm: "arm",
}

const platform = platformMap[os.platform()] ?? os.platform()
const arch = archMap[os.arch()] ?? os.arch()

function supportsAvx2() {
  if (arch !== "x64") return false

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "windows") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'

    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const output = (result.stdout || "").trim().toLowerCase()
        if (output === "true" || output === "1") return true
        if (output === "false" || output === "0") return false
      } catch {
        continue
      }
    }
  }

  return false
}

function isMusl() {
  if (platform !== "linux") return false

  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // Ignore filesystem probes that are blocked by the host.
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

export function packageNames(platform, arch, baseline, musl) {
  const base = `@ruying/ruying-code-${platform}-${arch}`

  if (platform === "linux") {
    if (musl) {
      if (arch === "x64")
        return baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
      return [`${base}-musl`, base]
    }

    if (arch === "x64")
      return baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
    return [base, `${base}-musl`]
  }

  if (arch === "x64") return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
  return [base]
}

export function launcherPlan(directory, runtimePlatform, runtimeArch, baseline, musl) {
  const selectedPlatform = platformMap[runtimePlatform] ?? runtimePlatform
  return {
    native: path.join(
      directory,
      "bin",
      selectedPlatform === "windows" ? "ruying-code-native.exe" : "ruying-code-native",
    ),
    source: selectedPlatform === "windows" ? "opencode.exe" : "opencode",
    packages: packageNames(selectedPlatform, archMap[runtimeArch] ?? runtimeArch, baseline, musl),
  }
}

export function installArguments(name, version) {
  return [
    "install",
    "--ignore-scripts",
    "--no-save",
    "--loglevel=error",
    "--registry=https://nexus.gwm.cn/repository/npm-group/",
    `${name}@${version}`,
  ]
}

function resolveBinary(name, source) {
  const packageJsonPath = require.resolve(`${name}/package.json`)
  const binaryPath = path.join(path.dirname(packageJsonPath), "bin", source)
  if (!fs.existsSync(binaryPath)) throw new Error(`Binary not found at ${binaryPath}`)
  return binaryPath
}

function installPackage(name, plan) {
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).optionalDependencies?.[name]
  if (!version) return

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ruying-code-install-"))
  try {
    const result = childProcess.spawnSync("npm", [...installArguments(name, version), "--prefix", temp], {
      stdio: "inherit",
      windowsHide: true,
    })
    if (result.status !== 0) return
    const packageDir = path.join(temp, "node_modules", name)
    copyBinary(path.join(packageDir, "bin", plan.source), plan.native)
    return true
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function copyBinary(source, target) {
  if (!fs.existsSync(source)) throw new Error(`Binary not found at ${source}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) fs.unlinkSync(target)
  try {
    fs.linkSync(source, target)
  } catch {
    fs.copyFileSync(source, target)
  }
  fs.chmodSync(target, 0o755)
}

function verifyBinary(binary) {
  const result = childProcess.spawnSync(binary, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  })
  return result.status === 0
}

function main() {
  const plan = launcherPlan(__dirname, platform, arch, arch === "x64" && !supportsAvx2(), isMusl())
  for (const name of plan.packages) {
    try {
      copyBinary(resolveBinary(name, plan.source), plan.native)
      if (verifyBinary(plan.native)) return
    } catch {
      if (installPackage(name, plan) && verifyBinary(plan.native)) return
    }
  }

  throw new Error(
    `It seems your package manager failed to install the right Ruying Code CLI package. Try manually installing ${plan.packages
      .map((name) => JSON.stringify(name))
      .join(" or ")}.`,
  )
}

export async function launch(args) {
  const plan = launcherPlan(__dirname, platform, arch, arch === "x64" && !supportsAvx2(), isMusl())
  const binary = fs.existsSync(plan.native)
    ? plan.native
    : plan.packages
        .map((name) => {
          try {
            return resolveBinary(name, plan.source)
          } catch {
            return
          }
        })
        .find((candidate) => candidate !== undefined)
  if (!binary) {
    throw new Error(
      `Ruying Code native binary is unavailable. Run node node_modules/@ruying/ruying-code/postinstall.mjs or install ${plan.packages
        .map((name) => JSON.stringify(name))
        .join(" or ")}.`,
    )
  }

  const child = childProcess.spawn(binary, args, { stdio: "inherit", windowsHide: true })
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"]
  const forward = (signal) => {
    if (!child.killed) child.kill(signal)
  }
  signals.forEach((signal) => process.on(signal, forward))
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  signals.forEach((signal) => process.off(signal, forward))
  if (result.signal) {
    process.kill(process.pid, result.signal)
    return
  }
  process.exitCode = result.code ?? 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
