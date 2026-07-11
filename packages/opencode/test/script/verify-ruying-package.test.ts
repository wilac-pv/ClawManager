import { expect, test } from "bun:test"
import path from "path"
import {
  isolatedEnvironment,
  packageInstallArguments,
  requireLifecycleEvidence,
  requirePostinstall,
} from "../../script/verify-ruying-package"
import { tmpdir } from "../fixture/fixture"

test("imports verifier helpers without running the package rehearsal", async () => {
  const probe = Bun.spawn(
    [
      "bun",
      "-e",
      `await import(${JSON.stringify(new URL("../../script/verify-ruying-package.ts", import.meta.url).href)}); process.stdout.write("clean import")`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )

  expect(await new Response(probe.stdout).text()).toBe("clean import")
  expect(await new Response(probe.stderr).text()).toBe("")
  expect(await probe.exited).toBe(0)
}, 20_000)

test("builds an allowlisted child environment without host secrets", async () => {
  await using tmp = await tmpdir()
  const env = isolatedEnvironment(
    tmp.path,
    {
      PATH: process.env.PATH,
      LANG: "en_US.UTF-8",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GH_TOKEN: "github-secret",
      NPM_TOKEN: "npm-secret",
      SSH_AUTH_SOCK: "/host/agent.sock",
    },
    "darwin",
  ) as Record<string, string>
  const allowed = new Set([
    "APPDATA",
    "CI",
    "HOME",
    "LANG",
    "LOCALAPPDATA",
    "NO_COLOR",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "npm_config_audit",
    "npm_config_cache",
    "npm_config_fetch_retries",
    "npm_config_fetch_timeout",
    "npm_config_fund",
    "npm_config_globalconfig",
    "npm_config_loglevel",
    "npm_config_offline",
    "npm_config_registry",
    "npm_config_update_notifier",
    "npm_config_userconfig",
  ])

  expect(Object.keys(env).every((name) => allowed.has(name))).toBeTrue()
  expect(env.HOME).toBe(path.join(tmp.path, "home"))
  expect(env.XDG_DATA_HOME).toBe(path.join(tmp.path, "data"))
  expect(env.XDG_STATE_HOME).toBe(path.join(tmp.path, "state"))
  expect(env.npm_config_registry).toBe("http://127.0.0.1:9/")
  expect(env.npm_config_offline).toBe("true")

  const probe = Bun.spawn(
    [
      "node",
      "-e",
      "process.stdout.write(JSON.stringify([process.env.AWS_SECRET_ACCESS_KEY, process.env.GH_TOKEN, process.env.NPM_TOKEN, process.env.SSH_AUTH_SOCK]))",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  )

  expect(await new Response(probe.stdout).text()).toBe("[null,null,null,null]")
  expect(await new Response(probe.stderr).text()).toBe("")
  expect(await probe.exited).toBe(0)
})

test("requires npm to run the packed wrapper lifecycle", async () => {
  const manifest = {
    name: "@ruying/ruying-code",
    version: "1.2.3",
    scripts: { postinstall: "node ./postinstall.mjs" },
  }
  const args = packageInstallArguments("platform.tgz", "wrapper.tgz") as string[]

  expect(args).toEqual([
    "install",
    "--offline",
    "--no-audit",
    "--no-fund",
    "--foreground-scripts",
    "platform.tgz",
    "wrapper.tgz",
  ])
  expect(args).not.toContain("--ignore-scripts")
  expect(requirePostinstall(manifest)).toBe("node ./postinstall.mjs")
  expect(() => requirePostinstall({ ...manifest, scripts: undefined })).toThrow(
    "Packed @ruying/ruying-code wrapper must declare postinstall",
  )
  expect(() => requireLifecycleEvidence("", manifest)).toThrow("npm did not report running")
  expect(
    requireLifecycleEvidence("\n> @ruying/ruying-code@1.2.3 postinstall\n> node ./postinstall.mjs\n", manifest),
  ).toBeUndefined()
})
