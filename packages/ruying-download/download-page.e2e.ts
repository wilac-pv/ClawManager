import { expect, test, type Locator, type Page } from "@playwright/test"

const macDownload =
  "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-mac-arm64.dmg"
const windowsDownload =
  "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-win-x64.exe"

test("keeps both platform downloads available", async ({ page }) => {
  await page.goto("/")

  await expectDownloads(page)
  await expect(page.getByRole("heading", { name: "让每一次编码，都有如影相随。" })).toBeVisible()
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

test("renders without horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  )
})

test("shows keyboard focus on the primary action", async ({ page }) => {
  await page.goto("/")
  const primary = page.locator("#primary-download")
  await focusByKeyboard(page, primary)

  await expect(primary).toBeFocused()
  await expect(page.locator("#primary-download:focus-visible")).toBeVisible()
  expect(
    await primary.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        color: style.outlineColor,
        style: style.outlineStyle,
        width: style.outlineWidth,
      }
    }),
  ).toEqual({ color: "rgb(167, 139, 250)", style: "solid", width: "3px" })
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
  await expect(card).toHaveCSS("border-color", "rgba(167, 139, 250, 0.7)")
  await expect(card).toHaveCSS("box-shadow", /rgba\(139, 92, 246, 0\.16\).*20px 56px/)
}

async function focusByKeyboard(page: Page, target: Locator) {
  await Array.from({ length: await page.locator("a[href]:visible").count() }).reduce(async (previous) => {
    await previous
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press("Tab")
  }, Promise.resolve())
}
