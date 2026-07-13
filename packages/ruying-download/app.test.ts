import { describe, expect, test } from "bun:test"
import { detectPlatform, recommendationFor } from "./app.js"

describe("download recommendation", () => {
  test("detects macOS", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac")
    expect(recommendationFor("mac")).toEqual({
      href: "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-mac-arm64.dmg",
      label: "下载 macOS 版",
      platform: "mac",
    })
  })

  test("detects Windows", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows")
    expect(recommendationFor("windows")).toEqual({
      href: "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-win-x64.exe",
      label: "下载 Windows 版",
      platform: "windows",
    })
  })

  test("falls back to platform selection", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("unknown")
    expect(recommendationFor("unknown")).toEqual({ href: "#download", label: "选择下载版本", platform: null })
  })
})
