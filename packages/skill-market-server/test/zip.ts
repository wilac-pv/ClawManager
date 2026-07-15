export function makeStoredZip(files: Record<string, string>) {
  const encoder = new TextEncoder()
  const entries = Object.entries(files).map(([name, content]) => ({
    name: encoder.encode(name),
    body: encoder.encode(content),
  }))
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  entries.forEach((entry) => {
    const header = new Uint8Array(30 + entry.name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint32(18, entry.body.length, true)
    view.setUint32(22, entry.body.length, true)
    view.setUint16(26, entry.name.length, true)
    header.set(entry.name, 30)
    local.push(header, entry.body)

    const directory = new Uint8Array(46 + entry.name.length)
    const directoryView = new DataView(directory.buffer)
    directoryView.setUint32(0, 0x02014b50, true)
    directoryView.setUint16(4, 0x0314, true)
    directoryView.setUint16(6, 20, true)
    directoryView.setUint32(20, entry.body.length, true)
    directoryView.setUint32(24, entry.body.length, true)
    directoryView.setUint16(28, entry.name.length, true)
    directoryView.setUint32(38, 0o100644 << 16, true)
    directoryView.setUint32(42, offset, true)
    directory.set(entry.name, 46)
    central.push(directory)
    offset += header.length + entry.body.length
  })
  const centralSize = central.reduce((total, entry) => total + entry.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
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
