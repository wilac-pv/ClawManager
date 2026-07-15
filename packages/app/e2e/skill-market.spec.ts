import { expect, test } from "@playwright/test"
import { setupSkillMarketFixture } from "./fixtures/skill-market"
import { trackPageErrors } from "./utils/errors"

test("installs and uninstalls a safe Skill without restarting", async ({ page }) => {
  const fixture = await setupSkillMarketFixture(page)
  const errors = trackPageErrors(page)
  await page.goto("/skills/skillhub/code-review")
  await page.waitForTimeout(500)
  expect(errors).toEqual([])
  await expect(page).toHaveURL(/\/skills\/skillhub\/code-review/)

  await expect(page.getByRole("heading", { name: "Code Review" })).toBeVisible()
  await page.getByRole("button", { name: "安装" }).click()
  await expect(page.getByText("已安装", { exact: true })).toBeVisible()
  expect(fixture.processRestartCount).toBe(0)

  await page.getByRole("button", { name: "卸载" }).click()
  expect(fixture.mutations).toEqual(["install"])
  await page.getByRole("button", { name: "确认卸载" }).click()
  await expect(page.getByRole("button", { name: "安装" })).toBeVisible()
  expect(fixture.mutations).toEqual(["install", "uninstall"])
})

test("requires the visible security report and explicit acceptance for a risky Skill", async ({ page }) => {
  const fixture = await setupSkillMarketFixture(page, "warning")
  const errors = trackPageErrors(page)
  await page.goto("/skills/skillhub/code-review")
  await page.waitForTimeout(500)
  expect(errors).toEqual([])
  await expect(page).toHaveURL(/\/skills\/skillhub\/code-review/)

  await page.getByRole("button", { name: "安装" }).click()
  await expect(page.getByText("This Skill can access the network.")).toBeVisible()
  await expect(page.getByRole("button", { name: "确认风险并安装" })).toBeDisabled()
  expect(fixture.mutations).toEqual([])
  await page.getByRole("checkbox", { name: "我已阅读并接受该 Skill 的风险" }).check()
  await page.getByRole("button", { name: "确认风险并安装" }).click()
  await expect(page.getByText("已安装", { exact: true })).toBeVisible()
  expect(fixture.mutations).toEqual(["install"])
})
