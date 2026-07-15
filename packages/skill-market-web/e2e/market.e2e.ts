import { expect, test } from "@playwright/test"

test("searches, filters, deep-links, copies a prompt and requests the verified download", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/skills")
  await expect(page.getByRole("heading", { name: "Skill 市场" })).toBeVisible()
  await page.getByRole("searchbox").fill("review")
  await expect(page.getByRole("button", { name: /Code Review/ })).toBeVisible()
  await page.getByLabel("来源").selectOption("skillhub")
  await expect(page.getByRole("button", { name: /Code Review/ })).toBeVisible()
  await page.getByRole("button", { name: /Code Review/ }).click()
  await expect(page).toHaveURL(/\/skills\/skillhub\/code-review$/)
  await page.getByRole("button", { name: "复制安装 Prompt" }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("SHA-256")
  await expect(page.getByRole("button", { name: "安装", exact: true })).toHaveCount(0)

  await page.route("https://downloads.example.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/zip", body: "fixture" }),
  )
  const request = page.waitForRequest(/\/v1\/catalog\/skills\/skillhub\/code-review\/download$/)
  await page.getByRole("button", { name: "下载 ZIP" }).click()
  await request
})

test("supports direct detail routes and keyboard-only tabs", async ({ page }) => {
  await page.goto("/skills/skillhub/code-review")
  await expect(page.getByRole("heading", { name: "Code Review", level: 1 })).toBeVisible()
  const overview = page.getByRole("tab", { name: "概述" })
  await overview.focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("tab", { name: "版本" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByText("1.2.0", { exact: true })).toBeVisible()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("tab", { name: "安全报告" })).toHaveAttribute("aria-selected", "true")
  await expect(page.getByText("未发现已知恶意行为")).toBeVisible()
})

test("stays light under a dark OS preference and persists list view", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.goto("/skills")
  await expect(page.locator(".ruying-skill-market")).toHaveCSS("background-color", "rgb(247, 248, 250)")
  if ((page.viewportSize()?.width ?? 0) > 760) {
    await page.getByRole("button", { name: "列表视图" }).click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem("ruying-skill-market-view"))).toBe("list")
  }
  await expect(page.getByText("收藏")).toHaveCount(0)
  await expect(page.getByText("评论")).toHaveCount(0)
})

test("renders not-found, partial-source, empty and icon fallback states", async ({ page }) => {
  await page.goto("/skills/skillhub/missing")
  await expect(page.getByRole("alert")).toContainText("不存在或已下架")

  await page.goto("/skills?q=partial")
  await expect(page.getByRole("status")).toContainText("部分来源")
  await page.getByRole("searchbox").fill("empty")
  await expect(page.getByText("没有找到匹配的 Skill")).toBeVisible()

  await page.route("https://cdn.example.com/**", (route) => route.abort())
  await page.goto("/skills")
  await expect(page.getByLabel("Code Review 默认图标")).toBeVisible()
})
