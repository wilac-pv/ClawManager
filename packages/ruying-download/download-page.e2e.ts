import { expect, test } from "@playwright/test"

const macDownload =
  "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-mac-arm64.dmg"
const windowsDownload =
  "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-win-x64.exe"

test("keeps both platform downloads available", async ({ page }) => {
  await page.goto("/")

  await expect(page.locator("[data-download-link]")).toHaveCount(2)
  await expect(page.locator('[data-platform="mac"] [data-download-link]')).toHaveAttribute("href", macDownload)
  await expect(page.locator('[data-platform="windows"] [data-download-link]')).toHaveAttribute("href", windowsDownload)
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
  await expect(page.locator('[data-platform="mac"]')).toHaveClass(/is-recommended/)
  await expect(page.locator('[data-platform="windows"]')).not.toHaveClass(/is-recommended/)
  await expect(page.locator("[data-download-link]")).toHaveCount(2)
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
  await expect(page.locator('[data-platform="windows"]')).toHaveClass(/is-recommended/)
  await expect(page.locator('[data-platform="mac"]')).not.toHaveClass(/is-recommended/)
  await expect(page.locator("[data-download-link]")).toHaveCount(2)
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
  await expect(page.locator("[data-download-link]")).toHaveCount(2)
})

test("renders without horizontal overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true)
})

test("shows keyboard focus on the primary action", async ({ page }) => {
  await page.goto("/")
  await page.keyboard.press("Tab")
  await expect(page.locator(":focus-visible")).toBeVisible()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")

  await expect(page.locator("#primary-download")).toBeFocused()
  await expect(page.locator("#primary-download:focus-visible")).toBeVisible()
})
