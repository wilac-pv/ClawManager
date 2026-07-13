import { describe, expect, test } from "bun:test"

const root = import.meta.dir
const html = await Bun.file(`${root}/index.html`).text()
const css = await Bun.file(`${root}/styles.css`).text()
const javascript = await Bun.file(`${root}/app.js`).text()
const playwright = await Bun.file(`${root}/playwright.config.ts`).text()
const design = await Bun.file(
  `${root}/../../docs/superpowers/specs/2026-07-13-ruying-code-download-page-design.md`,
).text()
const plan = await Bun.file(`${root}/../../docs/superpowers/plans/2026-07-13-ruying-code-download-page.md`).text()
const downloads = [
  "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-mac-arm64.dmg",
  "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-win-x64.exe",
]

function expectPresentationContract(source: string) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "")
  const root = cssBlock(css, /:root\s*/)
  const focus = cssBlock(css, /a:focus-visible\s*/)
  const mobile = cssBlock(css, /@media\s*\(max-width:\s*760px\)\s*/)
  const mobileGrids = cssBlock(mobile, /\.feature-grid\s*,\s*\.download-grid\s*,\s*\.install-grid\s*/)
  const reduced = cssBlock(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*/)
  const reducedTargets = cssBlock(reduced, /\*\s*,\s*\*::before\s*,\s*\*::after\s*/)

  expect(root).toContain("--color-accent: #8b5cf6;")
  expect(focus).toContain("outline: 3px solid var(--color-accent-bright);")
  expect(focus).toContain("outline-offset: 4px;")
  expect(mobileGrids).toContain("grid-template-columns: 1fr;")
  expect(reducedTargets).toContain("scroll-behavior: auto !important;")
  expect(reducedTargets).toContain("transition-duration: 0.01ms !important;")
  expect(reducedTargets).toContain("animation-duration: 0.01ms !important;")
  expect(reducedTargets).toContain("animation-iteration-count: 1 !important;")
}

function cssBlock(source: string, header: RegExp) {
  const match = header.exec(source)
  if (!match) throw new Error(`Missing CSS block matching ${header}`)
  const start = match.index + match[0].length
  const open = source.indexOf("{", start)
  if (open === -1 || source.slice(start, open).trim()) throw new Error(`Missing opening brace for ${header}`)

  let depth = 1
  for (let index = open + 1; index < source.length; index++) {
    if (source[index] === "{") depth++
    if (source[index] !== "}") continue
    depth--
    if (depth === 0) return source.slice(open + 1, index)
  }

  throw new Error(`Missing closing brace for ${header}`)
}

const validFocus = `
  a:focus-visible {
    outline: 3px solid var(--color-accent-bright);
    outline-offset: 4px;
  }
`
const validMobile = `
  @media (max-width: 760px) {
    .feature-grid, .download-grid, .install-grid {
      grid-template-columns: 1fr;
    }
  }
`
const validReducedMotion = `
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
    }
  }
`

function presentationFixture(focus = validFocus, mobile = validMobile, reducedMotion = validReducedMotion) {
  return `
    :root { --color-accent: #8b5cf6; }
    ${focus}
    ${mobile}
    ${reducedMotion}
  `
}

const invalidPresentations = [
  { name: "empty focus-visible rule", source: presentationFixture("a:focus-visible {}") },
  {
    name: "comment-only mobile grid rule",
    source: presentationFixture(
      validFocus,
      `
        @media (max-width: 760px) {
          .feature-grid, .download-grid, .install-grid {
            /* grid-template-columns: 1fr; */
          }
        }
      `,
    ),
  },
  {
    name: "empty reduced-motion rule",
    source: presentationFixture(validFocus, validMobile, "@media (prefers-reduced-motion: reduce) {}"),
  },
]

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

  test("documents the HTTP-only deployment contract", async () => {
    const file = Bun.file(`${root}/README.md`)
    expect(await file.exists()).toBe(true)
    const readme = await file.text()

    expect(design).toContain("HTTP-only")
    expect(plan).toContain("HTTP-only")
    expect(readme).toContain("HTTP-only")
    downloads.forEach((download) => expect(readme).toContain(download))
    expect(readme).toContain("index.html")
    expect(readme).toContain("app.js")
    expect(readme).toContain("测试")
    expect(readme).toContain("浏览器可信")
    expect(readme).toContain("同源 HTTPS 代理")
  })

  test("limits production and preview URLs to the approved HTTP boundary", () => {
    expect([...new Set(`${html}\n${javascript}\n${css}`.match(/https?:\/\/[^\s"']+/g) ?? [])].sort()).toEqual(
      downloads.toSorted(),
    )
    expect(playwright).toContain('baseURL: "http://localhost:4173"')
    expect(playwright).not.toContain('baseURL: "https://')
  })

  test("documents unsigned installation behavior", () => {
    expect(html).toContain("未签名")
    expect(html).toContain("SmartScreen")
    expect(html).toContain("隐私与安全性")
  })

  test("defines responsive and accessible presentation", () => {
    expectPresentationContract(css)
  })

  invalidPresentations.forEach((invalid) => {
    test(`rejects ${invalid.name}`, () => {
      expect(() => expectPresentationContract(invalid.source)).toThrow()
    })
  })
})
