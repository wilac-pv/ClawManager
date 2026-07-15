import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"

interface ScannableFile {
  readonly path: string
  readonly content: Uint8Array
}

const textLimit = 1024 * 1024

export function scanSubmissionFiles(files: ReadonlyArray<ScannableFile>, now: () => number = Date.now) {
  const evidence: SkillMarketControl.ScanEvidence[] = []
  const reasons = new Set<string>()
  let danger = false
  let hasLikelyCredential = false

  files.forEach((file) => {
    const path = file.path.toLocaleLowerCase()
    const executable = /\.(exe|com|msi|scr)$/i.test(path) || startsWith(file.content, [0x4d, 0x5a])
    if (executable) {
      danger = true
      reasons.add("Archive contains executable or native code")
      evidence.push({
        rule: "executable-file",
        summary: "Executable file signature or extension detected",
        path: file.path,
      })
    }
    const native =
      /\.(dll|so|dylib|node)$/i.test(path) ||
      startsWith(file.content, [0x7f, 0x45, 0x4c, 0x46]) ||
      startsWith(file.content, [0xcf, 0xfa, 0xed, 0xfe]) ||
      startsWith(file.content, [0xfe, 0xed, 0xfa, 0xcf])
    if (native) {
      danger = true
      reasons.add("Archive contains executable or native code")
      evidence.push({
        rule: "native-binary",
        summary: "Native binary signature or extension detected",
        path: file.path,
      })
    }
    if (/\.(sh|bash|zsh|fish|ps1|bat|cmd|vbs|js|mjs|cjs|py|rb|pl)$/i.test(path)) {
      reasons.add("Archive contains scripts requiring reviewer attention")
      evidence.push({ rule: "script-file", summary: "Script file detected", path: file.path })
    }

    const text = textual(file.content) ? new TextDecoder().decode(file.content.subarray(0, textLimit)) : ""
    if (!text) return
    if (/\b(curl|wget|Invoke-WebRequest)\b|\|\s*(sh|bash)\b/i.test(text)) {
      reasons.add("Archive contains network or command execution patterns")
      evidence.push({
        rule: "network-command",
        summary: "Network download or piped command pattern detected",
        path: file.path,
      })
    }
    if (/\b(crontab|launchctl|systemctl|schtasks)\b|\\CurrentVersion\\Run\b/i.test(text)) {
      reasons.add("Archive contains persistence-related patterns")
      evidence.push({ rule: "persistence", summary: "Persistence-related command pattern detected", path: file.path })
    }
    if (/<[^>]+\son[a-z]+\s*=|\b(?:javascript|vbscript):/i.test(text)) {
      reasons.add("Archive contains active HTML patterns")
      evidence.push({
        rule: "active-html",
        summary: "HTML event handler or dangerous protocol detected",
        path: file.path,
      })
    }
    if (/\bsk-[a-zA-Z0-9_-]{32,}\b|\bAKIA[0-9A-Z]{16}\b/.test(text)) {
      danger = true
      hasLikelyCredential = true
      reasons.add("Archive appears to contain a credential")
      evidence.push({
        rule: "likely-credential",
        summary: "Likely credential pattern detected and redacted",
        path: file.path,
      })
    }
  })

  const risk: SkillMarket.Risk = danger ? "danger" : evidence.length ? "warning" : "safe"
  return {
    report: {
      risk,
      reasons: [...reasons],
      evidence,
      scannedAt: new Date(now()).toISOString(),
    } satisfies SkillMarketControl.ScanReport,
    hasLikelyCredential,
  }
}

export function validateSubmissionIcon(body: Uint8Array, mime: string) {
  if (body.byteLength > 1024 * 1024) throw new Error("icon exceeds 1 MiB limit")
  const extension = {
    "image/png": () => validatePng(body),
    "image/jpeg": () => validateJpeg(body),
    "image/webp": () => validateWebp(body),
    "image/svg+xml": () => validateSvg(body),
  }[mime]
  if (!extension) throw new Error("icon MIME type is not allowed")
  extension()
  return {
    extension: { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" }[mime]!,
    sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
    size: body.byteLength,
    mime,
  }
}

function validatePng(body: Uint8Array) {
  if (
    body.byteLength < 33 ||
    !startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    new TextDecoder().decode(body.subarray(12, 16)) !== "IHDR"
  )
    throw new Error("PNG icon is malformed")
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  if (view.getUint32(16) === 0 || view.getUint32(20) === 0) throw new Error("PNG icon dimensions are invalid")
}

function validateJpeg(body: Uint8Array) {
  if (body.byteLength < 12 || !startsWith(body, [0xff, 0xd8]) || body.at(-2) !== 0xff || body.at(-1) !== 0xd9)
    throw new Error("JPEG icon is malformed")
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  let offset = 2
  while (offset + 4 <= body.byteLength - 2) {
    if (body[offset] !== 0xff) throw new Error("JPEG icon is malformed")
    const marker = body[offset + 1]
    const length = view.getUint16(offset + 2)
    if (length < 2 || offset + 2 + length > body.byteLength) throw new Error("JPEG icon is malformed")
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 7 || view.getUint16(offset + 5) === 0 || view.getUint16(offset + 7) === 0)
        throw new Error("JPEG icon dimensions are invalid")
      return
    }
    offset += 2 + length
  }
  throw new Error("JPEG icon has no supported frame")
}

function validateWebp(body: Uint8Array) {
  if (
    body.byteLength < 20 ||
    new TextDecoder().decode(body.subarray(0, 4)) !== "RIFF" ||
    new TextDecoder().decode(body.subarray(8, 12)) !== "WEBP" ||
    !["VP8 ", "VP8L", "VP8X"].includes(new TextDecoder().decode(body.subarray(12, 16)))
  )
    throw new Error("WebP icon is malformed")
}

function validateSvg(body: Uint8Array) {
  const svg = new TextDecoder("utf-8", { fatal: true }).decode(body).trim()
  if (!/^<svg(?:\s|>)/i.test(svg) || !/<\/svg>$/i.test(svg)) throw new Error("SVG icon is malformed")
  if (
    /<!DOCTYPE|<!ENTITY|<\s*(script|foreignObject|iframe|object|embed|image|a)\b/i.test(svg) ||
    /\son[a-z]+\s*=|\s(?:href|src)\s*=|\b(?:javascript|vbscript|data):|url\s*\(/i.test(svg)
  )
    throw new Error("SVG icon contains active content")
  const allowed = new Set([
    "svg",
    "g",
    "path",
    "circle",
    "rect",
    "line",
    "polyline",
    "polygon",
    "ellipse",
    "title",
    "desc",
    "defs",
    "lineargradient",
    "radialgradient",
    "stop",
    "clippath",
    "mask",
  ])
  const tags = [...svg.matchAll(/<\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)\b/g)].map((match) => match[1].toLocaleLowerCase())
  if (tags.some((tag) => !allowed.has(tag))) throw new Error("SVG icon contains a disallowed element")
}

function startsWith(body: Uint8Array, prefix: ReadonlyArray<number>) {
  return prefix.every((value, index) => body[index] === value)
}

function textual(body: Uint8Array) {
  return !body.subarray(0, Math.min(body.byteLength, 4_096)).some((value) => value === 0)
}
