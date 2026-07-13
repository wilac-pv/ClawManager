import { expect, test, type Page } from "@playwright/test"

const macDownload =
  "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-mac-arm64.dmg"
const windowsDownload =
  "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-win-x64.exe"
const layoutCases = [
  { columns: [3, 2, 2], name: "desktop", viewport: { height: 1000, width: 1440 } },
  { columns: [3, 2, 2], name: "tablet", viewport: { height: 1024, width: 768 } },
  { columns: [1, 1, 1], name: "mobile", viewport: { height: 844, width: 390 } },
] as const
const focusCases = [
  { name: "desktop", viewport: { height: 1000, width: 1440 } },
  { name: "mobile", viewport: { height: 844, width: 390 } },
] as const
const resourceTypes = ["document", "stylesheet", "script", "image"]

test("keeps both platform downloads available", async ({ page }) => {
  await page.goto("/")

  await expectDownloads(page)
  await expect(page.getByRole("heading", { name: "让每一次编码，都有如影相随。" })).toBeVisible()
})

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false })

  test("keeps both direct downloads visible and keyboard accessible", async ({ page }) => {
    await page.goto("/")

    await expectDownloads(page)
    expect(await expectKeyboardAccess(page)).toEqual(expect.arrayContaining([macDownload, windowsDownload]))
  })
})

test("recommends macOS without hiding Windows", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    })
  })
  await page.goto("/")

  await expect(page.locator("#primary-download")).toHaveText("下载 macOS 版")
  await expect(page.locator("#primary-download")).toHaveAttribute("href", macDownload)
  await expectCardTreatment(page, "mac", true)
  await expectCardTreatment(page, "windows", false)
  await expectDownloads(page)
})

test("recommends Windows without hiding macOS", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    })
  })
  await page.goto("/")

  await expect(page.locator("#primary-download")).toHaveText("下载 Windows 版")
  await expect(page.locator("#primary-download")).toHaveAttribute("href", windowsDownload)
  await expectCardTreatment(page, "windows", true)
  await expectCardTreatment(page, "mac", false)
  await expectDownloads(page)
})

test("keeps platform selection neutral for unknown systems", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (X11; Linux x86_64)",
    })
  })
  await page.goto("/")

  await expect(page.locator("#primary-download")).toHaveText("选择下载版本")
  await expect(page.locator("#primary-download")).toHaveAttribute("href", "#download")
  await expect(page.locator(".download-card.is-recommended")).toHaveCount(0)
  await expectCardTreatment(page, "mac", false)
  await expectCardTreatment(page, "windows", false)
  await expectDownloads(page)
})

layoutCases.forEach((layout) => {
  test(`renders ${layout.name} layout without overflow or overlap`, async ({ page }) => {
    await page.setViewportSize(layout.viewport)
    await page.goto("/")

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true)
    await expectGridLayout(page, ".feature-grid", layout.columns[0])
    await expectGridLayout(page, ".download-grid", layout.columns[1])
    await expectGridLayout(page, ".install-grid", layout.columns[2])
  })
})
focusCases.forEach((entry) => {
  test(`makes every visible link keyboard accessible on ${entry.name}`, async ({ page }) => {
    await page.setViewportSize(entry.viewport)
    await page.goto("/")

    expect((await expectKeyboardAccess(page)).length).toBeGreaterThan(0)
  })
})

test("loads only same-origin static page resources", async ({ page }) => {
  const requests: Array<{ type: string; url: string }> = []
  page.on("request", (request) => requests.push({ type: request.resourceType(), url: request.url() }))

  await page.goto("/", { waitUntil: "networkidle" })

  const origin = new URL(page.url()).origin
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every((request) => new URL(request.url).origin === origin)).toBe(true)
  expect(requests.every((request) => resourceTypes.includes(request.type))).toBe(true)
  resourceTypes.forEach((type) => expect(requests.some((request) => request.type === type)).toBe(true))
})

test("exposes semantic landmarks, headings, brand, and contextual downloads", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByRole("banner")).toBeVisible()
  await expect(page.getByRole("navigation", { name: "页面导航" })).toBeVisible()
  await expect(page.getByRole("main")).toBeVisible()
  await expect(page.getByRole("contentinfo")).toBeVisible()
  await expect(page.getByRole("img", { name: "如影 Code 图标" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "从理解到验证，始终与你并肩" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "选择适合你的桌面版本" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "首次安装指引" })).toBeVisible()
  await expect(page.locator('[data-platform="mac"]').getByRole("link", { name: "下载 macOS 版" })).toHaveAttribute(
    "href",
    macDownload,
  )
  await expect(
    page.locator('[data-platform="windows"]').getByRole("link", { name: "下载 Windows 版" }),
  ).toHaveAttribute("href", windowsDownload)
})

async function expectDownloads(page: Page) {
  const mac = page.locator('[data-platform="mac"] a[data-download-link]')
  const windows = page.locator('[data-platform="windows"] a[data-download-link]')

  await expect(page.locator("[data-download-link]")).toHaveCount(2)
  await expect(mac).toBeVisible()
  await expect(mac).toHaveAttribute("href", macDownload)
  await expect(windows).toBeVisible()
  await expect(windows).toHaveAttribute("href", windowsDownload)
}

async function expectCardTreatment(page: Page, platform: "mac" | "windows", recommended: boolean) {
  const card = page.locator(`[data-platform="${platform}"]`)

  await expect(card).toHaveClass(recommended ? /is-recommended/ : /^(?!.*is-recommended)/)
  expect(await card.evaluate((element) => getComputedStyle(element, "::after").content)).toBe(
    recommended ? '"推荐"' : "none",
  )
  if (!recommended) return
  await expect.poll(() => card.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none")
  const treatment = await card.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      borderColor: style.borderColor,
      borderStyle: style.borderStyle,
      borderWidth: style.borderWidth,
      boxShadow: style.boxShadow,
    }
  })
  expect(treatment.borderStyle).not.toBe("none")
  expect(Number.parseFloat(treatment.borderWidth)).toBeGreaterThan(0)
  expect(treatment.borderColor).not.toBe("rgba(0, 0, 0, 0)")
  expect(treatment.boxShadow).not.toBe("none")
}

async function expectGridLayout(page: Page, selector: string, columns: number) {
  const grid = page.locator(selector)
  await expect(grid).toBeVisible()
  expect(
    await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(/\s+/).filter(Boolean).length),
  ).toBe(columns)
  expect(
    await grid.locator(":scope > article").evaluateAll(
      (elements) =>
        elements.flatMap((element, index) => {
          const box = element.getBoundingClientRect()
          return elements.slice(index + 1).filter((candidate) => {
            const other = candidate.getBoundingClientRect()
            return box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top
          })
        }).length,
    ),
  ).toBe(0)
}

async function expectKeyboardAccess(page: Page) {
  const links = page.locator("a[href]:visible")
  const hrefs: Array<string> = []

  for (const index of Array.from({ length: await links.count() }, (_, index) => index)) {
    await page.keyboard.press("Tab")
    const link = links.nth(index)
    await expect(link).toBeFocused()
    expect(await link.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
    const outline = await link.evaluate((element) => {
      const style = getComputedStyle(element)
      return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth }
    })
    expect(outline.style).not.toBe("none")
    expect(Number.parseFloat(outline.width)).toBeGreaterThan(0)
    expect(["transparent", "rgba(0, 0, 0, 0)"]).not.toContain(outline.color)
    hrefs.push((await link.getAttribute("href")) ?? "")
  }

  return hrefs
}
