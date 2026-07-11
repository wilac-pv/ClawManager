import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Brand } from "@opencode-ai/core/brand/brand"

type UpgradeArgs = { target?: string; method?: string }
const supportedMethods: readonly Installation.Method[] = ["npm", "yarn", "pnpm", "bun"]

export async function resolveUpgrade(
  args: UpgradeArgs,
  dependencies: Pick<typeof Installation, "method" | "latest"> = Installation,
) {
  const explicitMethod = args.method as Installation.Method | undefined
  if (explicitMethod && !supportedMethods.includes(explicitMethod)) {
    throw new Installation.UpgradeFailedError({
      stderr: `${Brand.profile.englishName} does not support upgrades from ${explicitMethod}. Run: npm install -g ${Brand.profile.packageName} --registry=https://nexus.gwm.cn/repository/npm-group/`,
    })
  }
  const normalizedTarget = args.target ? Installation.normalizeVersion(args.target, true) : undefined
  if (args.target && !normalizedTarget) {
    throw new Installation.UpgradeFailedError({
      stderr: `${Brand.profile.englishName} refused invalid version "${args.target}". Use an exact semantic version such as 1.2.3.`,
    })
  }
  const method = explicitMethod ?? (await dependencies.method())
  const target = normalizedTarget ?? (await dependencies.latest(method))
  return { method, target }
}

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: `upgrade ${Brand.profile.englishName} to the latest or a specific version`,
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "yarn", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  handler: async (args: UpgradeArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const resolved = await resolveUpgrade(args).catch((error) => error)
    if (resolved instanceof Installation.UpgradeFailedError) {
      prompts.log.error(resolved.stderr)
      prompts.outro("Done")
      return
    }
    if (resolved instanceof Error) {
      prompts.log.error(resolved.message)
      prompts.outro("Done")
      return
    }
    const method = resolved.method
    prompts.log.info("Using method: " + method)
    const target = resolved.target

    if (InstallationVersion === target) {
      prompts.log.warn(`${Brand.profile.englishName} upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        prompts.log.error(err.stderr)
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
