import { Buffer } from "node:buffer"
import { mkdir } from "node:fs/promises"
import { deflateRawSync } from "node:zlib"

type Entry = {
  name: string
  data: string
  mode?: number
  extra?: Uint8Array
}

function number(size: 2 | 4, value: number) {
  const output = Buffer.alloc(size)
  if (size === 2) output.writeUInt16LE(value)
  if (size === 4) output.writeUInt32LE(value >>> 0)
  return output
}

function crc32(input: Uint8Array) {
  let value = 0xffffffff
  for (const byte of input) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  }
  return (value ^ 0xffffffff) >>> 0
}

function archive(entries: readonly Entry[]) {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  entries.forEach((entry) => {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data)
    const compressed = deflateRawSync(data)
    const extra = Buffer.from(entry.extra ?? [])
    const crc = crc32(data)
    const localHeader = Buffer.concat([
      number(4, 0x04034b50),
      number(2, 20),
      number(2, 0x0800),
      number(2, 8),
      number(2, 0),
      number(2, 0),
      number(4, crc),
      number(4, compressed.byteLength),
      number(4, data.byteLength),
      number(2, name.byteLength),
      number(2, extra.byteLength),
      name,
      extra,
    ])
    local.push(localHeader, compressed)
    central.push(
      Buffer.concat([
        number(4, 0x02014b50),
        number(2, 0x031e),
        number(2, 20),
        number(2, 0x0800),
        number(2, 8),
        number(2, 0),
        number(2, 0),
        number(4, crc),
        number(4, compressed.byteLength),
        number(4, data.byteLength),
        number(2, name.byteLength),
        number(2, extra.byteLength),
        number(2, 0),
        number(2, 0),
        number(2, 0),
        number(4, ((entry.mode ?? 0o100644) << 16) >>> 0),
        number(4, offset),
        name,
        extra,
      ]),
    )
    offset += localHeader.byteLength + compressed.byteLength
  })
  const directory = Buffer.concat(central)
  return Buffer.concat([
    ...local,
    directory,
    number(4, 0x06054b50),
    number(2, 0),
    number(2, 0),
    number(2, entries.length),
    number(2, entries.length),
    number(4, directory.byteLength),
    number(4, offset),
    number(2, 0),
  ])
}

function unixLinkExtra(target: string) {
  const body = Buffer.concat([Buffer.alloc(12), Buffer.from(target)])
  return Buffer.concat([number(2, 0x000d), number(2, body.byteLength), body])
}

await mkdir(import.meta.dir, { recursive: true })
await Promise.all([
  Bun.write(
    `${import.meta.dir}/valid.zip`,
    archive([
      { name: "SKILL.md", data: "---\nname: code-review\ndescription: Review code safely\n---\n# Code Review\n" },
      { name: "references/guide.md", data: "Review changed code and report actionable findings.\n" },
    ]),
  ),
  Bun.write(`${import.meta.dir}/traversal.zip`, archive([{ name: "../outside.txt", data: "escape" }])),
  Bun.write(`${import.meta.dir}/absolute.zip`, archive([{ name: "/tmp/ruying-escape.txt", data: "escape" }])),
  Bun.write(`${import.meta.dir}/symlink.zip`, archive([{ name: "SKILL.md", data: "target", mode: 0o120777 }])),
  Bun.write(
    `${import.meta.dir}/hardlink.zip`,
    archive([{ name: "SKILL.md", data: "target", extra: unixLinkExtra("../target") }]),
  ),
  Bun.write(`${import.meta.dir}/bomb.zip`, archive([{ name: "SKILL.md", data: "A".repeat(1024 * 1024) }])),
])
