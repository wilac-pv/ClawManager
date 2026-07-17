export function makeStoredZip(files: Record<string, string>) {
  return makeZip(Object.entries(files).map(([name, content]) => ({ name, content })))
}

export function makeZip(
  input: ReadonlyArray<{
    readonly name: string
    readonly content: string
    readonly flags?: number
    readonly method?: number
    readonly mode?: number
    readonly declaredCompressedSize?: number
    readonly declaredSize?: number
    readonly localName?: string
  }>,
  endOverrides: { readonly entries?: number; readonly centralSize?: number; readonly centralOffset?: number } = {},
) {
  const encoder = new TextEncoder()
  const entries = input.map((entry) => ({
    ...entry,
    name: encoder.encode(entry.name),
    localName: encoder.encode(entry.localName ?? entry.name),
    body: encoder.encode(entry.content),
    compressed: new Uint8Array(entry.method === 8 ? deflateRawSync(encoder.encode(entry.content)) : encoder.encode(entry.content)),
  }))
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  entries.forEach((entry) => {
    const header = new Uint8Array(30 + entry.localName.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, entry.flags ?? 0, true)
    view.setUint16(8, entry.method ?? 0, true)
    view.setUint32(14, crc32(entry.body), true)
    view.setUint32(18, entry.declaredCompressedSize ?? entry.compressed.length, true)
    view.setUint32(22, entry.declaredSize ?? entry.body.length, true)
    view.setUint16(26, entry.localName.length, true)
    header.set(entry.localName, 30)
    local.push(header, entry.compressed)

    const directory = new Uint8Array(46 + entry.name.length)
    const directoryView = new DataView(directory.buffer)
    directoryView.setUint32(0, 0x02014b50, true)
    directoryView.setUint16(4, 0x0314, true)
    directoryView.setUint16(6, 20, true)
    directoryView.setUint16(8, entry.flags ?? 0, true)
    directoryView.setUint16(10, entry.method ?? 0, true)
    directoryView.setUint32(16, crc32(entry.body), true)
    directoryView.setUint32(20, entry.declaredCompressedSize ?? entry.compressed.length, true)
    directoryView.setUint32(24, entry.declaredSize ?? entry.body.length, true)
    directoryView.setUint16(28, entry.name.length, true)
    directoryView.setUint32(38, (entry.mode ?? 0o100644) << 16, true)
    directoryView.setUint32(42, offset, true)
    directory.set(entry.name, 46)
    central.push(directory)
    offset += header.length + entry.compressed.length
  })
  const centralSize = central.reduce((total, entry) => total + entry.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, endOverrides.entries ?? entries.length, true)
  endView.setUint16(10, endOverrides.entries ?? entries.length, true)
  endView.setUint32(12, endOverrides.centralSize ?? centralSize, true)
  endView.setUint32(16, endOverrides.centralOffset ?? offset, true)
  return concat([...local, ...central, end])
}

function concat(parts: ReadonlyArray<Uint8Array>) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  parts.reduce((offset, part) => {
    output.set(part, offset)
    return offset + part.length
  }, 0)
  return output
}

function crc32(body: Uint8Array) {
  let crc = 0xffffffff
  body.forEach((value) => {
    crc ^= value
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  })
  return (crc ^ 0xffffffff) >>> 0
}
import { deflateRawSync } from "node:zlib"
