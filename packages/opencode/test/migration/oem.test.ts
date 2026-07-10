import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { OemMigration } from "../../src/migration/oem"

test("copies missing files and never overwrites the new tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-"))
  const legacy = join(root, "opencode")
  const current = join(root, "ruying-code")
  await mkdir(legacy, { recursive: true })
  await mkdir(current, { recursive: true })
  await writeFile(join(legacy, "auth.json"), "legacy")
  await writeFile(join(current, "auth.json"), "current")
  await writeFile(join(legacy, "opencode.db"), "session")

  const marker = join(root, "ruying-code-state", ".oem-migration-v1.json")
  await OemMigration.run({ pairs: [{ legacy, current }], marker })
  await OemMigration.run({ pairs: [{ legacy, current }], marker })

  expect(await readFile(join(current, "auth.json"), "utf8")).toBe("current")
  expect(await readFile(join(current, "opencode.db"), "utf8")).toBe("session")
  expect(await Bun.file(marker).exists()).toBe(true)
})

test("merges existing directories without overwriting nested branded files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-"))
  const legacy = join(root, "opencode")
  const current = join(root, "ruying-code")
  const marker = join(root, "ruying-code-state", ".oem-migration-v1.json")
  await mkdir(join(legacy, "plugins"), { recursive: true })
  await mkdir(join(current, "plugins"), { recursive: true })
  await writeFile(join(legacy, "plugins", "existing.ts"), "legacy")
  await writeFile(join(legacy, "plugins", "missing.ts"), "missing")
  await writeFile(join(current, "plugins", "existing.ts"), "current")

  const result = await OemMigration.run({ pairs: [{ legacy, current }], marker })

  expect(await Bun.file(join(current, "plugins", "existing.ts")).text()).toBe("current")
  expect(await Bun.file(join(current, "plugins", "missing.ts")).text()).toBe("missing")
  expect(result.copied).toEqual([join(legacy, "plugins", "missing.ts")])
  expect(result.skipped).toEqual([join(legacy, "plugins", "existing.ts")])
  expect(await Bun.file(marker).exists()).toBe(true)
})

test("writes the marker only after every path pair succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-"))
  const legacy = join(root, "opencode-data")
  const current = join(root, "ruying-code-data")
  const blocked = join(root, "blocked")
  const marker = join(root, "ruying-code-state", ".oem-migration-v1.json")
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, "opencode.db"), "session")
  await writeFile(blocked, "not a directory")

  await expect(
    OemMigration.run({
      pairs: [
        { legacy, current },
        { legacy, current: blocked },
      ],
      marker,
    }),
  ).rejects.toThrow()

  expect(await Bun.file(join(current, "opencode.db")).text()).toBe("session")
  expect(await Bun.file(marker).exists()).toBe(false)
})

test("does not mark malformed legacy roots as migrated", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-"))
  const legacy = join(root, "opencode")
  const marker = join(root, "ruying-code-state", ".oem-migration-v1.json")
  await writeFile(legacy, "not a directory")

  await expect(OemMigration.run({ pairs: [{ legacy, current: join(root, "ruying-code") }], marker })).rejects.toThrow()

  expect(await Bun.file(marker).exists()).toBe(false)
})

test("migrates all XDG trees before CLI command execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-cli-migrate-"))
  const bases = {
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    state: join(root, "state"),
  }
  await Promise.all(
    Object.entries(bases).map(async ([name, base]) => {
      await mkdir(join(base, "opencode"), { recursive: true })
      await writeFile(join(base, "opencode", `${name}.txt`), name)
    }),
  )

  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/index.ts"), "debug", "paths"], {
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...Bun.env,
      XDG_CONFIG_HOME: bases.config,
      XDG_DATA_HOME: bases.data,
      XDG_CACHE_HOME: bases.cache,
      XDG_STATE_HOME: bases.state,
    },
    stdout: "ignore",
    stderr: "pipe",
  })

  expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
  await Promise.all(
    Object.entries(bases).map(async ([name, base]) => {
      expect(await Bun.file(join(base, "ruying-code", `${name}.txt`)).text()).toBe(name)
    }),
  )
  expect(await Bun.file(join(bases.state, "ruying-code", ".oem-migration-v1.json")).exists()).toBe(true)
})
