import { expect, test, type Page, type TestInfo } from "@playwright/test"

const fixtureApi = "http://127.0.0.1:4210"
const csrfToken = "c".repeat(43)

test("aligns focus rings with composite and standalone controls", async ({ page }) => {
  await page.goto("/skills")
  const search = page.getByRole("searchbox")
  const searchFrame = page.locator(".ruying-skill-market__search")
  await search.focus()
  await expect(search).toHaveCSS("outline-style", "none")
  await expect(search).toHaveCSS("box-shadow", "none")
  await expect(searchFrame).toHaveCSS("border-color", "rgb(18, 104, 229)")
  await expect(searchFrame).toHaveCSS(
    "box-shadow",
    "rgba(18, 104, 229, 0.18) 0px 0px 0px 3px, rgba(17, 24, 39, 0.06) 0px 8px 28px 0px",
  )

  const source = page.getByLabel("来源")
  await source.focus()
  await expect(source).toHaveCSS("outline-style", "none")
  await expect(source).toHaveCSS("border-color", "rgb(18, 104, 229)")
  await expect(source).toHaveCSS("box-shadow", "rgba(18, 104, 229, 0.18) 0px 0px 0px 3px")
})

test("searches, filters, deep-links, copies a prompt and requests the verified download", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/skills")
  await expect(page.getByRole("heading", { name: "Skill 市场" })).toBeVisible()
  await page.getByRole("searchbox").fill("review")
  await expect(page.getByRole("button", { name: /^Code Review，/ })).toBeVisible()
  await page.getByLabel("来源").selectOption("skillhub")
  await expect(page.getByRole("button", { name: /^Code Review，/ })).toBeVisible()
  await page.getByRole("button", { name: /^Code Review，/ }).click()
  await expect(page).toHaveURL(/\/skills\/skillhub\/code-review$/)
  await page.getByRole("button", { name: "复制安装 Prompt" }).click()
  await expect(page.getByRole("button", { name: "已复制" })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("安装 Prompt 已复制到剪贴板")
  const prompt = await page.evaluate(() => navigator.clipboard.readText())
  expect(prompt).toContain("/v1/catalog/skills/skillhub/code-review/package")
  expect(prompt).not.toContain("downloads.example.com")
  expect(prompt).not.toContain("curl -k")
  await expect(page.getByRole("button", { name: "安装", exact: true })).toHaveCount(0)

  const request = page.waitForRequest(/\/v1\/catalog\/skills\/skillhub\/code-review\/package$/)
  await page.getByRole("button", { name: "下载 ZIP" }).click()
  expect((await request).url()).not.toContain("downloads.example.com")
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

test("opens community details and keeps submission inside the Web app", async ({ page }) => {
  await page.goto("/skills")
  await page.getByRole("button", { name: "用户投稿", exact: true }).click()
  await page.getByRole("button", { name: /^Community Review，/ }).click()
  await expect(page).toHaveURL(/\/skills\/community\/safe-community-skill$/)
  await expect(page.getByText("如影用户", { exact: true }).first()).toBeVisible()
  await page.goto("/skills")
  const submission = page.getByRole("link", { name: "投稿 Skill" })
  await expect(submission).toHaveAttribute("href", "/submissions/new")
  await submission.click()
  await expect(page).toHaveURL(/\/submissions\/new$/)
  await expect(page.getByRole("main").getByRole("heading", { name: "登录后继续" })).toBeVisible()
})

test("stays light under a dark OS preference and persists list view", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  await page.goto("/skills")
  await expect(page.locator(".ruying-skill-market")).toHaveCSS("background-color", "rgb(247, 248, 250)")
  if ((page.viewportSize()?.width ?? 0) > 760) {
    await page.getByRole("button", { name: "列表视图" }).click()
    await expect.poll(() => page.evaluate(() => localStorage.getItem("ruying-skill-market-view"))).toBe("list")
  }
  await expect(page.getByText("收藏")).toHaveCount(0)
  await expect(page.getByText("评论")).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true)
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

test("returns from SSO, reports invalid ZIP content and accepts a corrected revision", async ({ page }, testInfo) => {
  desktopControlOnly(testInfo)
  await resetFixture(page, "anonymous")
  await page.goto("/submissions/new")
  await page.getByRole("main").getByRole("button", { name: "使用 GWM SSO 登录" }).click()
  await expect(page).toHaveURL(/\/submissions\/new$/)
  await expect(page.getByRole("heading", { name: "投稿 Skill" })).toBeVisible()
  await page.getByRole("button", { name: "提交审核" }).click()
  await expect(page.getByRole("alert")).toBeFocused()

  await fillSubmission(page, "Invalid Community Skill", "1.0.0", "invalid.zip")
  await page.getByRole("button", { name: "提交审核" }).click()
  await expect(page).toHaveURL(/\/submissions\/sub_[a-zA-Z0-9_-]+$/)
  await expect(page.locator(".submission-status--validation_failed").first()).toBeVisible()
  await expect(page.getByText("SKILL_MD_MISSING")).toBeVisible()

  await page.getByRole("link", { name: "提交修订" }).click()
  await expect(page.getByRole("heading", { name: "提交修订" })).toBeVisible()
  await page.getByLabel("变更说明").fill("补充 SKILL.md")
  await page.getByLabel("Skill ZIP 包").setInputFiles({
    name: "valid.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("PK fixture with SKILL.md"),
  })
  const idempotencyKeys: string[] = []
  let interrupted = false
  await page.route(/\/v1\/submissions\/[^/]+\/revisions$/, async (route) => {
    idempotencyKeys.push(route.request().headers()["idempotency-key"] ?? "")
    if (interrupted) {
      await route.continue()
      return
    }
    interrupted = true
    await route.fetch()
    await route.abort("failed")
  })
  await page.getByRole("button", { name: "提交审核" }).click()
  await expect(page.getByRole("button", { name: "重试提交" })).toBeVisible()
  await page.getByRole("button", { name: "重试提交" }).click()
  await expect(page.locator(".submission-status--pending_review").first()).toBeVisible()
  expect(idempotencyKeys).toHaveLength(2)
  expect(idempotencyKeys[0]).toBe(idempotencyKeys[1])
})

test("keeps contributor records private and rechecks an expired deep-link session", async ({ page }, testInfo) => {
  desktopControlOnly(testInfo)
  await resetFixture(page, "submitter")
  await page.goto("/submissions")
  await expect(page.getByRole("heading", { name: "我的投稿" })).toBeVisible()
  await expect(page.getByRole("link", { name: "published-community-skill" })).toBeVisible()
  await expect(page.locator(".submission-status--changes_requested")).toBeVisible()
  await expect(page.locator(".submission-status--rejected")).toBeVisible()

  await page.goto("/submissions/sub_published01")
  await page.getByRole("link", { name: "提交新版本" }).click()
  await expect(page.getByRole("heading", { name: "提交新版本" })).toBeVisible()
  await page.getByLabel("版本号").fill("2.0.0")
  await page.getByLabel("变更说明").fill("第二个版本")
  await page.getByLabel("Skill ZIP 包").setInputFiles({
    name: "version-2.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("PK version 2 fixture"),
  })
  await page.getByRole("button", { name: "提交审核" }).click()
  await expect(page.locator(".submission-status--pending_review").first()).toBeVisible()
  await page.goto("/skills/community/published-community-skill")
  await expect(page.getByText("v1.0.0", { exact: true })).toBeVisible()

  await page.goto("/admin")
  await expect(page.getByRole("alert")).toContainText("没有访问权限")
  const privateRecord = await page.context().request.get(`${fixtureApi}/v1/submissions/sub_reviewrisk1`)
  expect(privateRecord.status()).toBe(403)

  await page.goto("/submissions/sub_changes001")
  await expect(page.getByRole("link", { name: "提交修订" })).toBeVisible()
  await page.context().request.post(`${fixtureApi}/__fixture/expire`)
  await page.reload()
  await expect(page.getByRole("main").getByRole("heading", { name: "登录后继续" })).toBeVisible()
})

test("enforces self-review, typed risk confirmation and optimistic conflicts", async ({ page }, testInfo) => {
  desktopControlOnly(testInfo)
  await resetFixture(page, "reviewer")
  await page.goto("/admin/submissions/sub_selfreview01")
  await expect(page.getByRole("alert")).toContainText("不能审核自己的投稿")
  await expect(page.getByRole("button", { name: "提交审核决定" })).toBeDisabled()

  await page.goto("/admin/submissions/sub_reviewrisk1")
  await page.getByRole("radio", { name: "通过" }).check()
  await page.getByLabel("审核意见").fill("已核对网络访问风险")
  await page.getByRole("button", { name: "提交审核决定" }).click()
  await expect(page.getByRole("alert")).toContainText("请输入 dangerous-community-skill 以确认")
  await page.getByLabel("输入 Skill ID 以确认").fill("dangerous-community-skill")
  await page.getByRole("button", { name: "提交审核决定" }).click()
  await expect(page).toHaveURL(/\/admin$/)

  await page.goto("/admin/submissions/sub_conflict001")
  await page.getByRole("radio", { name: "要求修改" }).check()
  await page.getByLabel("审核意见").fill("请补充使用说明")
  await page.context().request.post(`${fixtureApi}/__fixture/bump/sub_conflict001`)
  await page.getByRole("button", { name: "提交审核决定" }).click()
  await expect(page.getByRole("alert")).toContainText("投稿已更新，已刷新到最新版本")
  await expect(page.getByText("并发版本").locator("..")).toContainText("2")
})

test("enforces scoped sharing for group and department fixtures without public identity leakage", async ({ page }, testInfo) => {
  desktopControlOnly(testInfo)
  await resetFixture(page, "group-owner")
  expect((await page.context().request.get(`${fixtureApi}/v1/restricted-skills/pub_aurora01`)).ok()).toBe(true)
  const grant = await page.context().request.post(`${fixtureApi}/v1/restricted-skills/pub_aurora01/install-grants`)
  expect(grant.ok()).toBe(true)
  expect(grant.headers()["cache-control"]).toBe("no-store")

  await resetFixture(page, "group-member")
  expect((await page.context().request.get(`${fixtureApi}/v1/restricted-skills/pub_aurora01`)).ok()).toBe(true)
  await page.context().request.post(`${fixtureApi}/__fixture/remove-member`)
  expect((await page.context().request.get(`${fixtureApi}/v1/restricted-skills/pub_aurora01`)).status()).toBe(404)

  await resetFixture(page, "group-member")
  const initialCards = await page.context().request.get(`${fixtureApi}/v1/restricted-skills`)
  expect((await initialCards.json()).filter((item: { id: string }) => item.id === "pub_aurora01")).toHaveLength(1)
  await page.context().request.post(`${fixtureApi}/__fixture/disable-group`)
  const revokedCards = await page.context().request.get(`${fixtureApi}/v1/restricted-skills`)
  expect((await revokedCards.json()).filter((item: { id: string }) => item.id === "pub_aurora01")).toHaveLength(0)
  expect((await page.context().request.get(`${fixtureApi}/v1/restricted-skills/pub_aurora01`)).status()).toBe(404)

  await resetFixture(page, "same-department")
  expect((await page.context().request.get(`${fixtureApi}/v1/restricted-skills/pub_platform01/versions`)).ok()).toBe(true)
  await page.context().request.post(`${fixtureApi}/__fixture/move-department`)
  expect((await page.context().request.get(`${fixtureApi}/v1/restricted-skills/pub_platform01`)).status()).toBe(404)

  for (const persona of ["anonymous", "other-department"] as const) {
    await resetFixture(page, persona)
    expect((await page.context().request.get(`${fixtureApi}/v1/restricted-skills/pub_aurora01`)).status()).toBe(404)
  }
  await resetFixture(page, "outsider")
  const outsiderSession = await page.context().request.get(`${fixtureApi}/v1/auth/session`)
  expect((await outsiderSession.json()).user.employeeID).toBe("outsider")
  expect((await page.context().request.get(`${fixtureApi}/v1/restricted-skills/pub_aurora01`)).status()).toBe(404)
  await resetFixture(page, "admin")
  expect((await page.context().request.get(`${fixtureApi}/v1/restricted-skills/pub_aurora01`)).ok()).toBe(true)
  expect((await page.context().request.get(`${fixtureApi}/v1/catalog/skills/restricted/pub_aurora01`)).status()).toBe(404)
})

test("lets Admin retry publishing, moderate visibility, manage roles and filter audit", async ({ page }, testInfo) => {
  desktopControlOnly(testInfo)
  await resetFixture(page, "admin")
  await page.goto("/admin/submissions/sub_publishfail")
  await page.getByRole("button", { name: "重试发布" }).click()
  await expect(page.locator(".submission-status--published").first()).toBeVisible()
  await page.getByRole("button", { name: "下架 Skill" }).click()
  await page.getByLabel("操作原因").fill("E2E 下架验证")
  await page.getByRole("button", { name: "确认下架" }).click()
  await expect(page.getByRole("button", { name: "恢复 Skill" })).toBeVisible()
  await page.getByRole("button", { name: "恢复 Skill" }).click()
  await page.getByLabel("操作原因").fill("E2E 恢复验证")
  await page.getByRole("button", { name: "确认恢复" }).click()
  await expect(page.getByRole("button", { name: "下架 Skill" })).toBeVisible()

  await page.goto("/admin/roles")
  await page.getByLabel("员工工号").fill("reviewer2")
  await page.getByRole("button", { name: "添加角色" }).click()
  await expect(page.getByText("Reviewer Two")).toBeVisible()
  await page.getByRole("button", { name: "移除 reviewer2 的 Reviewer" }).click()
  await page.getByRole("button", { name: "确认移除" }).click()
  await expect(page.getByText("Reviewer Two")).toHaveCount(0)
  await page.getByRole("button", { name: "移除 admin1 的 Admin" }).click()
  await page.getByRole("button", { name: "确认移除" }).click()
  await expect(page.getByRole("alert")).toContainText("至少保留一名 Admin")

  await page.goto("/admin/audit")
  await page.getByLabel("操作类型").selectOption("community-restored")
  await expect(page.getByLabel("审计事件").getByText("Community Restored")).toBeVisible()
  await expect(page.locator(".audit-event pre")).not.toContainText(/csrf|secret|token/i)
})

test("keeps lifecycle visibility ahead of purge and artifact cleanup", async ({ page }, testInfo) => {
  desktopControlOnly(testInfo)
  await resetFixture(page, "submitter")
  const request = page.context().request
  const write = (method: "post" | "delete", path: string, data?: Record<string, unknown>) =>
    request[method](`${fixtureApi}${path}`, {
      data,
      headers: { Origin: "http://127.0.0.1:4211", "X-CSRF-Token": csrfToken, "Idempotency-Key": crypto.randomUUID() },
    })

  expect((await write("delete", "/v1/submissions/sub_personal01/personal", { expectedVersion: 1 })).ok()).toBe(true)
  expect(await (await request.get(`${fixtureApi}/v1/submissions?target=personal`)).json()).toMatchObject({ total: 0 })
  expect(await (await request.get(`${fixtureApi}/v1/personal-trash`)).json()).toHaveLength(1)
  expect((await write("post", "/v1/personal-trash/sub_personal01/restore", { expectedVersion: 2 })).ok()).toBe(true)
  expect(await (await request.get(`${fixtureApi}/v1/submissions?target=personal`)).json()).toMatchObject({ total: 1 })

  await write("delete", "/v1/submissions/sub_personal01/personal", { expectedVersion: 3 })
  await request.post(`${fixtureApi}/__fixture/clock`, { data: { now: "2026-07-22T08:00:00.000Z" } })
  await request.post(`${fixtureApi}/__fixture/worker/cleanup`)
  expect((await write("post", "/v1/personal-trash/sub_personal01/restore", { expectedVersion: 4 })).status()).toBe(409)

  await request.post(`${fixtureApi}/__fixture/worker/scanner-lease`, { data: { submissionID: "sub_scanner01" } })
  expect((await write("post", "/v1/submissions/sub_scanner01/withdraw", { expectedVersion: 1 })).ok()).toBe(true)
  await request.post(`${fixtureApi}/__fixture/worker/scanner-complete`, { data: { submissionID: "sub_scanner01" } })
  expect(await (await request.get(`${fixtureApi}/v1/submissions/sub_scanner01`)).json()).toMatchObject({ status: "withdrawn" })

  const delist = await write("post", "/v1/submissions/sub_published01/delist-requests", {
    expectedVersion: 1,
    reason: "No longer maintained",
  })
  expect(delist.ok()).toBe(true)
  const requestID = (await delist.json()).id
  await request.get(`${fixtureApi}/v1/auth/login?persona=admin`)
  expect((await write("post", `/v1/admin/delist-requests/${requestID}/approve`, { expectedVersion: 1 })).ok()).toBe(true)
  expect((await request.get(`${fixtureApi}/v1/catalog/skills/community/published-community-skill`)).status()).toBe(404)
  expect(await (await request.get(`${fixtureApi}/v1/admin/submissions/sub_published01/delist-requests`)).json()).toMatchObject([
    { id: requestID, status: "approved" },
  ])
  expect(await (await request.post(`${fixtureApi}/__fixture/worker/cleanup`)).json()).toMatchObject({ deleted: [] })
})

test("keeps workspace pages and the upload form inside the mobile viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-light", "Responsive layout check runs on the mobile project")
  await resetFixture(page, "submitter")

  for (const path of ["/personal", "/submissions", "/favorites", "/submissions/new?target=personal"]) {
    await page.goto(path)
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
      .toBe(true)
  }

  await page.goto("/personal")
  const personalWidth = await page.locator("main").evaluate((element) => Math.round(element.getBoundingClientRect().width))
  await page.goto("/favorites")
  await expect
    .poll(() => page.locator("main").evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(personalWidth)
  await expect(page.getByRole("banner")).toHaveCount(1)
})

async function resetFixture(
  page: Page,
  persona:
    | "anonymous"
    | "submitter"
    | "reviewer"
    | "admin"
    | "group-owner"
    | "group-member"
    | "outsider"
    | "same-department"
    | "other-department",
) {
  const response = await page.context().request.post(`${fixtureApi}/__fixture/reset?persona=${persona}`)
  expect(response.ok()).toBe(true)
}

async function fillSubmission(page: Page, name: string, version: string, packageName: string) {
  await page.getByLabel("版本号").fill(version)
  await page.getByLabel("Skill 名称").fill(name)
  await page.getByLabel("简介").fill("用于浏览器端到端验证的社区 Skill")
  await page.getByLabel("分类").fill("代码质量")
  await page.getByLabel("标签").fill("review,community")
  await page.getByLabel("许可证（可选）").fill("MIT")
  await page.getByLabel("变更说明").fill("首次投稿")
  await page.getByLabel("Skill ZIP 包").setInputFiles({
    name: packageName,
    mimeType: "application/zip",
    buffer: Buffer.from("PK fixture"),
  })
}

function desktopControlOnly(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== "desktop-light", "Stateful control journeys run once on desktop Chromium")
}
