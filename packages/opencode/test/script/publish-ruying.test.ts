import { expect, test } from "bun:test"
import { symlink } from "fs/promises"
import path from "path"
import {
  INSTALL_REGISTRY,
  launcherSource,
  npmPublishArguments,
  npmViewArguments,
  packagePlan,
  platformDependencies,
  platformDirectory,
  platformManifest,
  PUBLISH_REGISTRY,
  releaseArtifact,
  releaseMetadata,
  removeTarballs,
  SUPPORTED_TARGETS,
  wrapperManifest,
} from "../../script/publish-ruying"
import { installArguments, launcherPlan, packageNames } from "../../script/postinstall.mjs"
import { tmpdir } from "../fixture/fixture"

test("imports the OEM publisher without public network or Script evaluation", async () => {
  const source = await Bun.file(`${import.meta.dir}/../../script/publish-ruying.ts`).text()

  expect(source).not.toContain("@opencode-ai/script")
  expect(source).not.toContain("registry.npmjs.org")

  const probe = Bun.spawn(
    [
      "bun",
      "-e",
      [
        'globalThis.fetch = () => { throw new Error("public fetch attempted") }',
        `await import(${JSON.stringify(new URL("../../script/publish-ruying.ts", import.meta.url).href)})`,
        'process.stdout.write("clean import")',
      ].join(";"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )

  expect(await new Response(probe.stdout).text()).toBe("clean import")
  expect(await new Response(probe.stderr).text()).toBe("")
  expect(await probe.exited).toBe(0)
})

test("requires explicit valid release metadata before real publishing", () => {
  expect(() => releaseMetadata([], {}, "1.2.3", false)).toThrow("explicit release version and tag")
  expect(releaseMetadata(["--version", "1.2.3", "--tag=beta"], {}, "1.2.3", false)).toEqual({
    version: "1.2.3",
    tag: "beta",
  })
  expect(() => releaseMetadata(["--version", "2.0.0", "--tag", "latest"], {}, "1.2.3", false)).toThrow(
    "does not match built package version",
  )
  expect(() => releaseMetadata(["--version", "invalid", "--tag", "latest"], {}, "1.2.3", false)).toThrow(
    "Invalid release version",
  )
  expect(() => releaseMetadata(["--version", "1.2.3", "--tag="], {}, "1.2.3", false)).toThrow(
    "explicit release version and tag",
  )
})

test("rejects SemVer-range tags before fetch or npm commands", async () => {
  await using tmp = await tmpdir()
  const repository = `${tmp.path}/repo`
  const opencode = `${repository}/packages/opencode`
  const publisher = `${opencode}/script/publish-ruying.ts`
  const marker = `${tmp.path}/npm-called`
  await Bun.$`mkdir -p ${opencode}/script ${opencode}/dist ${tmp.path}/bin`
  await symlink(path.join(import.meta.dir, "../../node_modules"), `${opencode}/node_modules`)
  await Bun.write(publisher, await Bun.file(`${import.meta.dir}/../../script/publish-ruying.ts`).text())
  await Bun.write(
    `${opencode}/script/postinstall.mjs`,
    await Bun.file(`${import.meta.dir}/../../script/postinstall.mjs`).text(),
  )
  await Bun.write(`${repository}/LICENSE`, "test")
  await Promise.all(
    SUPPORTED_TARGETS.map(async (target) => {
      const directory = `${opencode}/dist/${platformDirectory(target)}`
      await Bun.$`mkdir -p ${directory}`
      await Bun.write(`${directory}/package.json`, JSON.stringify(platformManifest("1.2.3", target)))
    }),
  )
  await Bun.write(`${tmp.path}/preload.ts`, 'globalThis.fetch = () => { throw new Error("fetch attempted") }\n')
  await Bun.write(
    `${tmp.path}/bin/npm`,
    `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, "called")\nprocess.exit(86)\n`,
  )
  await Bun.$`chmod 755 ${tmp.path}/bin/npm`

  for (const tag of ["1.2", "1.x", "v1"]) {
    if (await Bun.file(marker).exists()) await Bun.file(marker).delete()
    const result = Bun.spawn(
      [process.execPath, "--preload", `${tmp.path}/preload.ts`, publisher, "--version", "1.2.3", `--tag=${tag}`],
      {
        env: { ...process.env, PATH: `${tmp.path}/bin${path.delimiter}${process.env.PATH ?? ""}` },
        stdout: "ignore",
        stderr: "pipe",
      },
    )

    expect(await new Response(result.stderr).text()).toContain(`Invalid release tag: ${tag}`)
    expect(await result.exited).not.toBe(0)
    expect(await Bun.file(marker).exists()).toBeFalse()
  }
})

test("uses deterministic local metadata for pack-only rehearsals", () => {
  expect(releaseMetadata([], {}, "1.2.3-local.1", true)).toEqual({ version: "1.2.3-local.1", tag: "" })
  expect(
    releaseMetadata([], { RUYING_CODE_RELEASE_VERSION: "1.2.3", RUYING_CODE_RELEASE_TAG: "next" }, "1.2.3", false),
  ).toEqual({ version: "1.2.3", tag: "next" })
})

test("creates a dual-bin scoped wrapper", () => {
  const manifest = wrapperManifest("1.2.3", { "@ruying/ruying-code-darwin-arm64": "1.2.3" })

  expect(manifest.name).toBe("@ruying/ruying-code")
  expect(manifest.bin).toEqual({ "ruying-code": "./bin/ruying-code", opencode: "./bin/ruying-code" })
  expect(manifest.optionalDependencies).toEqual({ "@ruying/ruying-code-darwin-arm64": "1.2.3" })
})

test("keeps Windows and POSIX npm shims on an extensionless Node launcher", () => {
  const manifest = wrapperManifest("1.2.3", { "@ruying/ruying-code-windows-x64": "1.2.3" })
  const windows = launcherPlan("C:\\wrapper", "win32", "x64", false, false)
  const posix = launcherPlan("/wrapper", "darwin", "arm64", false, false)

  expect(manifest.bin).toEqual({ "ruying-code": "./bin/ruying-code", opencode: "./bin/ruying-code" })
  expect(launcherSource()).toStartWith("#!/usr/bin/env node\n")
  expect(launcherSource()).not.toContain("#!/bin/sh")
  expect(windows.native).toEndWith("ruying-code-native.exe")
  expect(windows.source).toBe("opencode.exe")
  expect(windows.packages).toEqual(["@ruying/ruying-code-windows-x64", "@ruying/ruying-code-windows-x64-baseline"])
  expect(posix.native).toBe("/wrapper/bin/ruying-code-native")
  expect(posix.source).toBe("opencode")
  expect(posix.packages).toEqual(["@ruying/ruying-code-darwin-arm64"])
})

test("the Node launcher forwards POSIX arguments and exit codes", async () => {
  await using tmp = await tmpdir()
  await Bun.$`mkdir -p ${tmp.path}/bin`
  await Bun.write(
    `${tmp.path}/postinstall.mjs`,
    await Bun.file(`${import.meta.dir}/../../script/postinstall.mjs`).text(),
  )
  await Bun.write(`${tmp.path}/bin/ruying-code`, launcherSource())
  await Bun.write(
    `${tmp.path}/bin/ruying-code-native`,
    "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\nprocess.exit(23)\n",
  )
  await Bun.$`chmod 755 ${tmp.path}/bin/ruying-code-native`

  const launcher = Bun.spawn(["node", `${tmp.path}/bin/ruying-code`, "alpha", "two words"], {
    stdout: "pipe",
    stderr: "pipe",
  })

  expect(await new Response(launcher.stdout).text()).toBe('["alpha","two words"]')
  expect(await launcher.exited).toBe(23)
})

test("the Node launcher forwards termination signals", async () => {
  await using tmp = await tmpdir()
  await Bun.$`mkdir -p ${tmp.path}/bin`
  await Bun.write(
    `${tmp.path}/postinstall.mjs`,
    await Bun.file(`${import.meta.dir}/../../script/postinstall.mjs`).text(),
  )
  await Bun.write(`${tmp.path}/bin/ruying-code`, launcherSource())
  await Bun.write(
    `${tmp.path}/bin/ruying-code-native`,
    [
      "#!/usr/bin/env node",
      'import fs from "fs"',
      `fs.writeFileSync(${JSON.stringify(`${tmp.path}/ready`)}, "ready")`,
      'process.on("SIGTERM", () => { process.stdout.write("forwarded"); process.exit(42) })',
      "setTimeout(() => process.exit(91), 1000)",
      "",
    ].join("\n"),
  )
  await Bun.$`chmod 755 ${tmp.path}/bin/ruying-code-native`
  const launcher = Bun.spawn(["node", `${tmp.path}/bin/ruying-code`], { stdout: "pipe", stderr: "pipe" })
  const output = new Response(launcher.stdout).text()

  for (let attempt = 0; attempt < 1000 && !(await Bun.file(`${tmp.path}/ready`).exists()); attempt++) {
    await Bun.sleep(1)
  }
  expect(await Bun.file(`${tmp.path}/ready`).exists()).toBeTrue()
  launcher.kill("SIGTERM")

  expect(await output).toBe("forwarded")
  expect(await launcher.exited).toBe(42)
})

test("creates scoped platform manifests without scoped directory paths", () => {
  const target = { os: "win32", arch: "x64" as const, abi: "musl" as const, avx2: false as const }

  expect(platformDirectory(target)).toBe("ruying-code-windows-x64-baseline-musl")
  expect(platformManifest("1.2.3", target)).toEqual({
    name: "@ruying/ruying-code-windows-x64-baseline-musl",
    version: "1.2.3",
    preferUnplugged: true,
    os: ["win32"],
    cpu: ["x64"],
    libc: ["musl"],
  })
})

test("plans release archives from unscoped platform directories", () => {
  expect(releaseArtifact({ os: "linux", arch: "x64" })).toEqual({
    directory: "ruying-code-linux-x64",
    archive: "ruying-code-linux-x64.tar.gz",
  })
  expect(releaseArtifact({ os: "win32", arch: "arm64" })).toEqual({
    directory: "ruying-code-windows-arm64",
    archive: "ruying-code-windows-arm64.zip",
  })
  expect(releaseArtifact({ os: "darwin", arch: "arm64" }).directory).not.toContain("/")
})

test("uses Nexus group for installs and hosted releases for publishing", () => {
  expect(INSTALL_REGISTRY).toBe("https://nexus.gwm.cn/repository/npm-group/")
  expect(PUBLISH_REGISTRY).toBe("https://nexus.gwm.cn/repository/npm-releases/")
})

test("selects scoped platform packages and installs fallbacks from Nexus", () => {
  expect(packageNames("linux", "x64", true, false)).toEqual([
    "@ruying/ruying-code-linux-x64-baseline",
    "@ruying/ruying-code-linux-x64",
    "@ruying/ruying-code-linux-x64-baseline-musl",
    "@ruying/ruying-code-linux-x64-musl",
  ])
  expect(installArguments("@ruying/ruying-code-linux-x64", "1.2.3")).toEqual([
    "install",
    "--ignore-scripts",
    "--no-save",
    "--loglevel=error",
    "--registry=https://nexus.gwm.cn/repository/npm-group/",
    "@ruying/ruying-code-linux-x64@1.2.3",
  ])
})

test("publishes only scoped platform dependencies to the hosted registry", () => {
  expect(
    platformDependencies([
      { name: "@ruying/ruying-code-darwin-arm64", version: "1.2.3" },
      { name: "@ruying/ruying-code", version: "1.2.3" },
      { name: "opencode-linux-x64", version: "1.2.3" },
    ]),
  ).toEqual({ "@ruying/ruying-code-darwin-arm64": "1.2.3" })
  expect(npmPublishArguments("ruying-ruying-code-1.2.3.tgz", "beta")).toEqual([
    "publish",
    "ruying-ruying-code-1.2.3.tgz",
    "--registry=https://nexus.gwm.cn/repository/npm-releases/",
    "--tag",
    "beta",
  ])
  expect(npmViewArguments("@ruying/ruying-code", "1.2.3")).toEqual([
    "view",
    "@ruying/ruying-code@1.2.3",
    "version",
    "--registry=https://nexus.gwm.cn/repository/npm-group/",
  ])
})

test("refuses real publishing for incomplete, extra, or malformed platform sets", () => {
  const complete = SUPPORTED_TARGETS.map((target) => platformManifest("1.2.3", target))

  expect(() => packagePlan([complete[0]], false)).toThrow("complete supported platform set")
  expect(() => packagePlan([...complete, { ...complete[0], name: "@ruying/ruying-code-plan9-x64" }], false)).toThrow(
    "Unexpected platform package",
  )
  expect(() =>
    packagePlan(
      complete.map((manifest, index) => (index ? manifest : { ...manifest, os: ["darwin"] })),
      false,
    ),
  ).toThrow("Malformed platform package")
})

test("accepts the exact complete target set before creating publish arguments", () => {
  const plan = packagePlan(
    SUPPORTED_TARGETS.map((target) => platformManifest("1.2.3", target)),
    false,
  )

  expect(Object.keys(plan.optionalDependencies)).toHaveLength(SUPPORTED_TARGETS.length)
  expect(plan.os).toEqual(["darwin", "linux", "win32"])
  expect(plan.cpu).toEqual(["arm64", "x64"])
  expect(npmPublishArguments("package.tgz", "latest")).toEqual([
    "publish",
    "package.tgz",
    "--registry=https://nexus.gwm.cn/repository/npm-releases/",
    "--tag",
    "latest",
  ])
})

test("describes a partial pack-only wrapper honestly", () => {
  const plan = packagePlan([platformManifest("1.2.3", { os: "darwin", arch: "arm64" })], true)
  const manifest = wrapperManifest(plan.version, plan.optionalDependencies, plan)

  expect(manifest.optionalDependencies).toEqual({ "@ruying/ruying-code-darwin-arm64": "1.2.3" })
  expect(manifest.os).toEqual(["darwin"])
  expect(manifest.cpu).toEqual(["arm64"])
})

test("cleans tarballs when the package directory starts empty", async () => {
  await using tmp = await tmpdir()

  await removeTarballs(tmp.path)
  await Bun.write(`${tmp.path}/old.tgz`, "old")
  await Bun.write(`${tmp.path}/keep.txt`, "keep")
  await removeTarballs(tmp.path)

  expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: tmp.path }))).toEqual(["keep.txt"])
})
