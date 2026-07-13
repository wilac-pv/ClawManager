import { describe, expect, test } from "bun:test"

const root = import.meta.dir
const html = await Bun.file(`${root}/index.html`).text()
const css = await Bun.file(`${root}/styles.css`).text()

describe("ruying download page content", () => {
  test("contains the approved product structure", () => {
    expect(html).toContain("让每一次编码，都有如影相随。")
    expect(html).toContain('id="features"')
    expect(html).toContain('id="download"')
    expect(html).toContain('id="install"')
    expect(html).toContain("企业 SSO")
    expect(html).toContain("仅供长城汽车内部研发使用")
  })

  test("keeps both direct download links in HTML", () => {
    expect(html).toContain("ruying-code-desktop-mac-arm64.dmg")
    expect(html).toContain("ruying-code-desktop-win-x64.exe")
    expect(html.match(/data-download-link/g)?.length).toBe(2)
  })

  test("documents unsigned installation behavior", () => {
    expect(html).toContain("未签名")
    expect(html).toContain("SmartScreen")
    expect(html).toContain("隐私与安全性")
  })

  test("defines responsive and accessible presentation", () => {
    expect(css).toContain("--color-accent")
    expect(css).toContain(":focus-visible")
    expect(css).toContain("prefers-reduced-motion: reduce")
    expect(css).toContain("@media (max-width: 760px)")
  })
})
