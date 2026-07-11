import { expect, test } from "bun:test"
import { lstat, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises"
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

test("coalesces simultaneous first-launch copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-race-"))
  const legacy = join(root, "opencode")
  const current = join(root, "ruying-code")
  const marker = join(root, "state", ".oem-migration-v1.json")
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, "auth.json"), "x".repeat(2_000_000))

  await Promise.all(Array.from({ length: 16 }, () => OemMigration.run({ pairs: [{ legacy, current }], marker })))

  expect((await readFile(join(current, "auth.json"), "utf8")).length).toBe(2_000_000)
  expect(await Bun.file(marker).exists()).toBe(true)
})

test("does not expose a partially copied directory before migration publishes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-atomic-"))
  const legacy = join(root, "opencode")
  const current = join(root, "ruying-code")
  const source = join(legacy, "workspace")
  const target = join(current, "workspace")
  const marker = join(root, "state", ".oem-migration-v1.json")
  await mkdir(source, { recursive: true })
  await Promise.all(
    Array.from({ length: 800 }, (_, index) => writeFile(join(source, `${index.toString().padStart(4, "0")}.txt`), "x")),
  )

  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'const { OemMigration } = await import("./src/migration/oem.ts"); await OemMigration.run({ pairs: [{ legacy: process.env.LEGACY, current: process.env.CURRENT }], marker: process.env.MARKER })',
    ],
    {
      cwd: join(import.meta.dir, "../.."),
      env: { ...Bun.env, LEGACY: legacy, CURRENT: current, MARKER: marker },
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  let complete = false
  let partial = false
  void child.exited.then(() => (complete = true))
  while (!complete) {
    const count = await readdir(target)
      .then((entries) => entries.length)
      .catch(() => 0)
    if (count > 0 && count < 800) partial = true
    await Bun.sleep(1)
  }

  expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
  expect(partial).toBe(false)
  expect((await readdir(target)).length).toBe(800)
})

test("recovers an abandoned process lock after a crashed migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-crash-"))
  const legacy = join(root, "opencode")
  const current = join(root, "ruying-code")
  const marker = join(root, "state", ".oem-migration-v1.json")
  const lock = `${marker}.lock`
  await mkdir(legacy, { recursive: true })
  await mkdir(join(root, "state"), { recursive: true })
  await writeFile(join(legacy, "auth.json"), "legacy")
  await writeFile(lock, JSON.stringify({ pid: 2_147_483_647, token: "dead", createdAt: Date.now() }))

  await OemMigration.run({ pairs: [{ legacy, current }], marker })

  expect(await Bun.file(join(current, "auth.json")).text()).toBe("legacy")
  expect(await Bun.file(lock).exists()).toBe(false)
})

test("serializes migration across independent processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-processes-"))
  const legacy = join(root, "opencode")
  const current = join(root, "ruying-code")
  const marker = join(root, "state", ".oem-migration-v1.json")
  await mkdir(join(legacy, "workspace"), { recursive: true })
  await Promise.all(
    Array.from({ length: 300 }, (_, index) => writeFile(join(legacy, "workspace", `${index}.txt`), `${index}`)),
  )

  const children = Array.from({ length: 8 }, () =>
    Bun.spawn(
      [
        process.execPath,
        "--eval",
        'const { OemMigration } = await import("./src/migration/oem.ts"); await OemMigration.run({ pairs: [{ legacy: process.env.LEGACY, current: process.env.CURRENT }], marker: process.env.MARKER })',
      ],
      {
        cwd: join(import.meta.dir, "../.."),
        env: { ...Bun.env, LEGACY: legacy, CURRENT: current, MARKER: marker },
        stdout: "ignore",
        stderr: "pipe",
      },
    ),
  )
  const exits = await Promise.all(children.map((child) => child.exited))

  expect(exits).toEqual(Array(8).fill(0))
  expect((await readdir(join(current, "workspace"))).length).toBe(300)
  expect(await Bun.file(`${marker}.lock`).exists()).toBe(false)
  expect((await readdir(current)).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
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

test("does not copy a legacy marker before later pairs succeed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-"))
  const legacy = join(root, "opencode-state")
  const current = join(root, "ruying-code-state")
  const blocked = join(root, "blocked")
  const marker = join(current, ".oem-migration-v1.json")
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, ".oem-migration-v1.json"), "legacy marker")
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

  expect(await Bun.file(marker).exists()).toBe(false)
})

test("does not follow a legacy marker symlink when completing migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-"))
  const legacy = join(root, "opencode-state")
  const current = join(root, "ruying-code-state")
  const marker = join(current, ".oem-migration-v1.json")
  const external = join(root, "external.json")
  await mkdir(legacy, { recursive: true })
  await writeFile(external, "external")
  await symlink(external, join(legacy, ".oem-migration-v1.json"))

  await OemMigration.run({ pairs: [{ legacy, current }], marker })

  expect(await Bun.file(external).text()).toBe("external")
  expect((await lstat(marker)).isSymbolicLink()).toBe(false)
})

test("writes a regular completion marker after successful migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-"))
  const marker = join(root, "ruying-code-state", ".oem-migration-v1.json")
  await mkdir(marker, { recursive: true })

  await OemMigration.run({ pairs: [], marker })

  expect((await lstat(marker)).isFile()).toBe(true)
})

test("preserves a non-empty marker directory and aborts migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-migrate-"))
  const marker = join(root, "ruying-code-state", ".oem-migration-v1.json")
  await mkdir(marker, { recursive: true })
  await writeFile(join(marker, "keep.txt"), "keep")

  await expect(OemMigration.run({ pairs: [], marker })).rejects.toThrow()

  expect(await Bun.file(join(marker, "keep.txt")).text()).toBe("keep")
  expect((await lstat(marker)).isDirectory()).toBe(true)
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

test("migrates before direct Server.listen and accepts an explicit desktop legacy state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-server-migrate-"))
  const state = join(root, "state")
  const legacyDesktop = join(root, "legacy-electron")
  await mkdir(join(legacyDesktop, "opencode"), { recursive: true })
  await writeFile(join(legacyDesktop, "opencode", "session.db"), "legacy desktop session")

  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'const { Server } = await import("./src/node.ts"); const server = await Server.listen({ hostname: "127.0.0.1", port: 0, legacyStateRoot: process.env.LEGACY_ROOT }); await server.stop()',
    ],
    {
      cwd: join(import.meta.dir, "../.."),
      env: { ...Bun.env, XDG_STATE_HOME: state, LEGACY_ROOT: legacyDesktop },
      stdout: "ignore",
      stderr: "pipe",
    },
  )

  expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
  expect(await Bun.file(join(state, "ruying-code", "session.db")).text()).toBe("legacy desktop session")
})

test("runs Desktop legacy-state migration after the default migration already completed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-desktop-state-migrate-"))
  const state = join(root, "state")
  const legacyDesktop = join(root, "legacy-electron")
  await mkdir(join(legacyDesktop, "opencode"), { recursive: true })
  await writeFile(join(legacyDesktop, "opencode", "session.db"), "legacy desktop session")

  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'const { OemMigration } = await import("./src/migration/oem.ts"); await OemMigration.runDefault(); await OemMigration.runDefault({ legacyStateRoot: process.env.LEGACY_ROOT })',
    ],
    {
      cwd: join(import.meta.dir, "../.."),
      env: { ...Bun.env, XDG_STATE_HOME: state, LEGACY_ROOT: legacyDesktop },
      stdout: "ignore",
      stderr: "pipe",
    },
  )

  expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
  expect(await Bun.file(join(state, "ruying-code", "session.db")).text()).toBe("legacy desktop session")
  expect(await Bun.file(join(state, "ruying-code", ".oem-desktop-state-migration-v1.json")).exists()).toBe(true)
})

test("migrates before the first in-process Server.Default request", async () => {
  const root = await mkdtemp(join(tmpdir(), "ruying-default-app-migrate-"))
  const config = join(root, "config")
  await mkdir(join(config, "opencode"), { recursive: true })
  await writeFile(join(config, "opencode", "legacy.json"), "legacy config")

  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'const { Server } = await import("./src/node.ts"); await Server.Default().app.fetch(new Request("http://localhost/global/health")); process.exit(0)',
    ],
    {
      cwd: join(import.meta.dir, "../.."),
      env: { ...Bun.env, XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(root, "state") },
      stdout: "ignore",
      stderr: "pipe",
    },
  )

  expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
  expect(await Bun.file(join(config, "ruying-code", "legacy.json")).text()).toBe("legacy config")
})
