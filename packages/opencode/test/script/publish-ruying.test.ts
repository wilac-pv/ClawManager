import { expect, test } from "bun:test"
import {
  INSTALL_REGISTRY,
  npmPublishArguments,
  npmViewArguments,
  platformDependencies,
  platformDirectory,
  platformManifest,
  PUBLISH_REGISTRY,
  removeTarballs,
  wrapperManifest,
} from "../../script/publish-ruying"
import { installArguments, packageNames } from "../../script/postinstall.mjs"
import { tmpdir } from "../fixture/fixture"

test("creates a dual-bin scoped wrapper", () => {
  const manifest = wrapperManifest("1.2.3", { "@ruying/ruying-code-darwin-arm64": "1.2.3" })

  expect(manifest.name).toBe("@ruying/ruying-code")
  expect(manifest.bin).toEqual({ "ruying-code": "./bin/ruying-code", opencode: "./bin/ruying-code" })
  expect(manifest.optionalDependencies).toEqual({ "@ruying/ruying-code-darwin-arm64": "1.2.3" })
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

test("cleans tarballs when the package directory starts empty", async () => {
  await using tmp = await tmpdir()

  await removeTarballs(tmp.path)
  await Bun.write(`${tmp.path}/old.tgz`, "old")
  await Bun.write(`${tmp.path}/keep.txt`, "keep")
  await removeTarballs(tmp.path)

  expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: tmp.path }))).toEqual(["keep.txt"])
})
