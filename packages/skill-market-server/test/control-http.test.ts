import { afterEach, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAnnouncements } from "../src/announcements"
import { createAuth } from "../src/auth"
import type { CatalogReader } from "../src/catalog-reader"
import { openDatabase } from "../src/database"
import { createExpertPackages } from "../src/expert-packages"
import { createFavorites } from "../src/favorites"
import { createGroups } from "../src/groups"
import { createInstallGrants } from "../src/install-grants"
import { createMarketWebHandler } from "../src/handlers"
import { createModeration } from "../src/moderation"
import { createPersonalTrash } from "../src/personal-trash"
import type { PrivateObjectStore } from "../src/oss"
import { MAX_CATALOG_PACKAGE_SIZE } from "../src/package-reader"
import { createRestrictedCatalog } from "../src/restricted-catalog"
import { createSecurity, hashSecret } from "../src/security"
import { createSkillHubImportAdmin } from "../src/skillhub-import-admin"
import { createSkillHubImportStore } from "../src/skillhub-import-store"
import { createSkillHubEvaluationStore } from "../src/skillhub-evaluation-store"
import { createSubmissions } from "../src/submissions"
import { sampleCatalogReader, sampleDetail, sampleSnapshot } from "./fixture"
import { makeStoredZip } from "./zip"

const directories: string[] = []
const webOrigin = "http://127.0.0.1:4211"
const webBaseUrl = `${webOrigin}/ai-coding/ruying-code/skill-market/`
const now = Date.parse("2026-07-15T00:00:00.000Z")

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("skill market control HTTP", () => {
  test("serves typed group management with session, CSRF, and optimistic conflict protection", async () => {
    await using fixture = await marketFixture()

    const anonymous = await fetch(`${fixture.url}/v1/groups`)
    expect(anonymous.status).toBe(401)

    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fsubmissions`, { redirect: "manual" })
    const session = await loginSession(fixture, login)
    const missingCsrf = await fetch(`${fixture.url}/v1/groups`, {
      method: "POST",
      headers: { cookie: session.cookie, origin: webOrigin, "content-type": "application/json" },
      body: JSON.stringify({ name: "Project Aurora" }),
    })
    expect(missingCsrf.status).toBe(403)

    const createdResponse = await fetch(`${fixture.url}/v1/groups`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Project Aurora", description: "跨部门专项组" }),
    })
    expect(createdResponse.status).toBe(200)
    expect(createdResponse.headers.get("access-control-allow-origin")).toBe(webOrigin)
    const created = Schema.decodeUnknownSync(SkillMarketControl.MarketGroup)(await createdResponse.json())

    const addedResponse = await fetch(`${fixture.url}/v1/groups/${created.id}/members`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ employeeID: "future-user", expectedVersion: created.version }),
    })
    expect(addedResponse.status).toBe(200)
    expect(Schema.decodeUnknownSync(SkillMarketControl.MarketGroupMember)(await addedResponse.json())).toMatchObject({
      groupID: created.id,
      employeeID: "future-user",
    })

    const conflict = await fetch(`${fixture.url}/v1/groups/${created.id}`, {
      method: "PATCH",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedVersion: created.version, name: "Stale update" }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: "submission-conflict", requestId: expect.any(String) })

    fixture.database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
      ["future-user", "Future User", now, now],
    )
    fixture.database.connection.run("UPDATE sessions SET employee_id = ? WHERE employee_id = ?", [
      "future-user",
      "E123456",
    ])
    const update = (name: string) =>
      fetch(`${fixture.url}/v1/groups/${created.id}`, {
        method: "PATCH",
        headers: {
          cookie: session.cookie,
          origin: webOrigin,
          "x-csrf-token": session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedVersion: 2, name }),
      })
    const memberUpdate = await update("Member cannot rename")
    expect(memberUpdate.status).toBe(403)
    expect(await memberUpdate.json()).toMatchObject({ code: "forbidden", requestId: expect.any(String) })

    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, 'admin', NULL, ?)",
      ["future-user", now],
    )
    const adminUpdate = await update("Admin repaired name")
    expect(adminUpdate.status).toBe(200)
    expect(Schema.decodeUnknownSync(SkillMarketControl.MarketGroup)(await adminUpdate.json())).toMatchObject({
      id: created.id,
      name: "Admin repaired name",
      version: 3,
    })

    const detailResponse = await fetch(`${fixture.url}/v1/groups/${created.id}`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(detailResponse.status).toBe(200)
    const membersResponse = await fetch(`${fixture.url}/v1/groups/${created.id}/members`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(membersResponse.status).toBe(200)
    expect(
      Schema.decodeUnknownSync(Schema.Array(SkillMarketControl.MarketGroupMember))(await membersResponse.json()),
    ).toHaveLength(2)

    const pageResponse = await fetch(`${fixture.url}/v1/groups`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(pageResponse.status).toBe(200)
    expect(Schema.decodeUnknownSync(SkillMarketControl.GroupPage)(await pageResponse.json())).toMatchObject({
      managed: [{ id: created.id, version: 3 }],
      joined: [],
    })

    fixture.database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
      ["outsider", "Outsider", now, now],
    )
    fixture.database.connection.run("UPDATE sessions SET employee_id = ? WHERE employee_id = ?", [
      "outsider",
      "future-user",
    ])
    const hiddenDetail = await fetch(`${fixture.url}/v1/groups/${created.id}`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(hiddenDetail.status).toBe(404)
    expect(await hiddenDetail.json()).toMatchObject({ code: "not-found", requestId: expect.any(String) })
    const hiddenMembers = await fetch(`${fixture.url}/v1/groups/${created.id}/members`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(hiddenMembers.status).toBe(404)

    const preflight = await fetch(`${fixture.url}/v1/groups/${created.id}`, {
      method: "OPTIONS",
      headers: { origin: webOrigin, "access-control-request-method": "PATCH" },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PATCH")
  })

  test("serves announcement history publicly and protects announcement publishing", async () => {
    await using fixture = await marketFixture()
    fixture.database.connection.run(
      `INSERT INTO announcements (id, title, summary, content, published_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["ann_abcdefgh", "市场公告", "公告摘要", "# 公告正文", now],
    )

    const history = await fetch(`${fixture.url}/v1/catalog/announcements?page=1&limit=5`)
    expect(history.status).toBe(200)
    expect(history.headers.get("access-control-allow-origin")).toBe("*")
    expect(Schema.decodeUnknownSync(SkillMarket.AnnouncementPage)(await history.json())).toMatchObject({
      total: 1,
      items: [{ id: "ann_abcdefgh", title: "市场公告" }],
    })

    const detail = await fetch(`${fixture.url}/v1/catalog/announcements/ann_abcdefgh`)
    expect(Schema.decodeUnknownSync(SkillMarket.AnnouncementDetail)(await detail.json())).toMatchObject({
      content: "# 公告正文",
    })

    const publish = await fetch(`${fixture.url}/v1/admin/announcements`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: webOrigin },
      body: JSON.stringify({ title: "Unauthorized", summary: "No session", content: "Blocked" }),
    })
    expect(publish.status).toBe(401)
  })

  test("serves the public catalog with wildcard GET, HEAD, and OPTIONS behavior", async () => {
    await using fixture = await marketFixture()
    const page = await fetch(`${fixture.url}/v1/catalog/skills?page=1&limit=30`)
    expect(page.status).toBe(200)
    expect(page.headers.get("access-control-allow-origin")).toBe("*")
    expect(page.headers.has("access-control-allow-credentials")).toBe(false)
    expect(page.headers.get("x-skill-market-revision")).toBe("r1")
    expect(Schema.decodeUnknownSync(SkillMarket.Page)(await page.json()).items).toHaveLength(1)

    const head = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review`, { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(head.headers.get("x-skill-market-revision")).toBe("r1")

    const preflight = await fetch(`${fixture.url}/v1/catalog/skills`, { method: "OPTIONS" })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS")
  })

  test("merges only current restricted access and delivers private packages through bounded grants", async () => {
    await using fixture = await marketFixture({ publicCommunityID: "pub_httpgroup01" })
    const body = new TextEncoder().encode("restricted package body")
    const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex")
    const users = fixture.database.transaction((connection) => {
      connection.run(
        "INSERT INTO departments (department_id, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
        ["engineering", "Engineering", now, now, "other", "Other", now, now],
      )
      const owner = seedHttpSession(connection, "restricted-owner", "engineering")
      const admin = seedHttpSession(connection, "restricted-admin", "other", ["admin"])
      const department = seedHttpSession(connection, "restricted-department", "engineering")
      const group = seedHttpSession(connection, "restricted-group", "other")
      const outsider = seedHttpSession(connection, "restricted-outsider", "other")
      connection.run(
        `INSERT INTO market_groups (id, name, owner_employee_id, status, version, created_at, updated_at)
         VALUES ('grp_httpactive1', 'HTTP Active', 'restricted-owner', 'active', 1, ?, ?),
                ('grp_httpdisable', 'HTTP Disabled', 'restricted-owner', 'disabled', 1, ?, ?)`,
        [now, now, now, now],
      )
      connection.run(
        `INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at)
         VALUES ('grp_httpactive1', 'restricted-group', 'restricted-owner', ?),
                ('grp_httpdisable', 'restricted-group', 'restricted-owner', ?)`,
        [now, now],
      )
      seedCatalogPublication(connection, {
        id: "pub_httpgroup01",
        submissionID: "sub_httpgroup01",
        skillID: "http-group-skill",
        scope: "groups",
        groupID: "grp_httpactive1",
        key: "skill-market-private/http-group.zip",
        sha256,
        size: body.byteLength,
      })
      seedCatalogPublication(connection, {
        id: "pub_httpdepart1",
        submissionID: "sub_httpdepart1",
        skillID: "http-department-skill",
        scope: "department",
        departmentID: "engineering",
        key: "skill-market-private/http-department.zip",
        sha256,
        size: body.byteLength,
      })
      seedCatalogPublication(connection, {
        id: "pub_httpdisable",
        submissionID: "sub_httpdisable",
        skillID: "http-disabled-skill",
        scope: "groups",
        groupID: "grp_httpdisable",
        key: "skill-market-private/http-disabled.zip",
        sha256,
        size: body.byteLength,
      })
      seedCatalogPublication(connection, {
        id: "pub_httpdelist1",
        submissionID: "sub_httpdelist1",
        skillID: "http-delisted-skill",
        scope: "groups",
        groupID: "grp_httpactive1",
        key: "skill-market-private/http-delisted.zip",
        sha256,
        size: body.byteLength,
        status: "delisted",
      })
      return { owner, admin, department, group, outsider }
    })
    ;[
      "skill-market-private/http-group.zip",
      "skill-market-private/http-department.zip",
      "skill-market-private/http-disabled.zip",
      "skill-market-private/http-delisted.zip",
    ].forEach((key) => fixture.objects.set(key, body))

    const anonymous = await fetch(`${fixture.url}/v1/catalog/skills?page=1&limit=30`)
    expect(
      Schema.decodeUnknownSync(SkillMarket.Page)(await anonymous.json()).items
        .filter((item) => item.id === "pub_httpgroup01")
        .map((item) => item.source),
    ).toEqual(["community"])
    expect(anonymous.headers.get("cache-control")).toBe("public, max-age=60")
    const invalidSession = await fetch(`${fixture.url}/v1/catalog/skills?page=1&limit=30`, {
      headers: { cookie: "ruying_market_session=invalid; ruying_market_csrf=invalid" },
    })
    expect(invalidSession.status).toBe(200)
    expect(
      Schema.decodeUnknownSync(SkillMarket.Page)(await invalidSession.json()).items
        .filter((item) => item.id === "pub_httpgroup01")
        .map((item) => item.source),
    ).toEqual(["community"])
    expect(invalidSession.headers.get("cache-control")).toBe("public, max-age=60")

    const groupList = await fetch(`${fixture.url}/v1/catalog/skills?page=1&limit=30`, {
      headers: { cookie: users.group.cookie },
    })
    expect(groupList.headers.get("cache-control")).toBe("private, no-store")
    expect(Schema.decodeUnknownSync(SkillMarket.Page)(await groupList.json()).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "pub_httpgroup01", visibility: "groups" })]),
    )
    const groupCatalog = await fetch(`${fixture.url}/v1/catalog/skills?page=1&limit=30`, {
      headers: { cookie: users.group.cookie },
    })
    expect(
      Schema.decodeUnknownSync(SkillMarket.Page)(await groupCatalog.json()).items
        .filter((item) => item.id === "pub_httpgroup01")
        .map((item) => item.source)
        .toSorted(),
    ).toEqual(["community", "restricted"])
    expect((await fetch(`${fixture.url}/v1/catalog/skills/restricted/pub_httpgroup01`)).status).toBe(400)
    const outsiderList = await fetch(`${fixture.url}/v1/catalog/skills?page=1&limit=30`, {
      headers: { cookie: users.outsider.cookie },
    })
    expect(
      Schema.decodeUnknownSync(SkillMarket.Page)(await outsiderList.json()).items
        .filter((item) => item.id === "pub_httpgroup01")
        .map((item) => item.source),
    ).toEqual(["community"])

    const anonymousDetail = await fetch(`${fixture.url}/v1/restricted-skills/pub_httpgroup01`)
    expect(anonymousDetail.status).toBe(404)
    expect(anonymousDetail.headers.get("cache-control")).toBe("private, no-store")
    const groupDetail = await fetch(`${fixture.url}/v1/restricted-skills/pub_httpgroup01`, {
      headers: { cookie: users.group.cookie },
    })
    expect(groupDetail.status).toBe(200)
    expect(groupDetail.headers.get("cache-control")).toBe("private, no-store")
    const detailJson = await groupDetail.json()
    expect(detailJson).toMatchObject({ id: "pub_httpgroup01", visibility: "groups" })
    expect(JSON.stringify(detailJson)).not.toContain("skill-market-private")
    const versions = await fetch(`${fixture.url}/v1/restricted-skills/pub_httpgroup01/versions`, {
      headers: { cookie: users.group.cookie },
    })
    expect(versions.status).toBe(200)
    expect(versions.headers.get("cache-control")).toBe("private, no-store")
    expect(await versions.json()).toEqual([expect.objectContaining({ version: "1.0.0", sha256 })])
    const outsiderDetail = await fetch(`${fixture.url}/v1/restricted-skills/pub_httpgroup01`, {
      headers: { cookie: users.outsider.cookie },
    })
    expect(outsiderDetail.status).toBe(404)
    expect(outsiderDetail.headers.get("cache-control")).toBe("private, no-store")
    expect(
      (
        await fetch(`${fixture.url}/v1/restricted-skills/pub_httpdisable`, {
          headers: { cookie: users.group.cookie },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await fetch(`${fixture.url}/v1/restricted-skills/pub_httpdisable`, {
          headers: { cookie: users.owner.cookie },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${fixture.url}/v1/restricted-skills/pub_httpdisable`, {
          headers: { cookie: users.admin.cookie },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${fixture.url}/v1/restricted-skills/pub_httpdepart1`, {
          headers: { cookie: users.department.cookie },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${fixture.url}/v1/restricted-skills/pub_httpdepart1`, {
          headers: { cookie: users.outsider.cookie },
        })
      ).status,
    ).toBe(404)
    const departmentGrantResponse = await fetch(
      `${fixture.url}/v1/restricted-skills/pub_httpdepart1/install-grants`,
      {
        method: "POST",
        headers: {
          cookie: users.department.cookie,
          origin: webOrigin,
          "x-csrf-token": users.department.csrf,
        },
      },
    )
    expect(departmentGrantResponse.status).toBe(200)
    const departmentGrant = Schema.decodeUnknownSync(SkillMarket.PrivateInstallGrant)(await departmentGrantResponse.json())
    expect(
      (
        await fetch(`${fixture.url}${new URL(departmentGrant.url).pathname}`, {
          method: "HEAD",
        })
      ).status,
    ).toBe(200)
    const outsiderGrant = await fetch(`${fixture.url}/v1/restricted-skills/pub_httpdepart1/install-grants`, {
      method: "POST",
      headers: { cookie: users.outsider.cookie, origin: webOrigin, "x-csrf-token": users.outsider.csrf },
    })
    expect(outsiderGrant.status).toBe(404)
    expect(outsiderGrant.headers.get("cache-control")).toBe("private, no-store")
    expect(
      [401, 403].includes(
        (
          await fetch(`${fixture.url}/v1/restricted-skills/pub_httpdepart1/install-grants`, {
            method: "POST",
            headers: { origin: webOrigin },
          })
        ).status,
      ),
    ).toBeTrue()
    fixture.database.connection.run("UPDATE users SET department_id = 'other' WHERE employee_id = 'restricted-department'")
    expect(
      (
        await fetch(`${fixture.url}/v1/restricted-skills/pub_httpdepart1`, {
          headers: { cookie: users.department.cookie },
        })
      ).status,
    ).toBe(404)
    expect((await fetch(`${fixture.url}${new URL(departmentGrant.url).pathname}`)).status).toBe(404)
    expect(
      (
        await fetch(`${fixture.url}/v1/restricted-skills/pub_httpdelist1`, {
          headers: { cookie: users.owner.cookie },
        })
      ).status,
    ).toBe(404)

    const grantResponse = await fetch(`${fixture.url}/v1/restricted-skills/pub_httpgroup01/install-grants`, {
      method: "POST",
      headers: { cookie: users.group.cookie, origin: webOrigin, "x-csrf-token": users.group.csrf },
    })
    expect(grantResponse.status).toBe(200)
    expect(grantResponse.headers.get("cache-control")).toBe("private, no-store")
    const grant = Schema.decodeUnknownSync(SkillMarket.PrivateInstallGrant)(await grantResponse.json())
    const grantUrl = new URL(grant.url)
    const token = grantUrl.pathname.split("/").at(-1)!
    expect(grantUrl.origin).toBe("https://market.example")
    expect(grant.expiresAt).toBe(new Date(now + 10 * 60_000).toISOString())
    expect(JSON.stringify(grant)).not.toContain("skill-market-private")
    const grantRow = fixture.database.connection
      .query<{ token_hash: string }, [string]>(
        "SELECT token_hash FROM private_install_grants WHERE publication_id = ? ORDER BY created_at DESC",
      )
      .get("pub_httpgroup01")!
    expect(grantRow.token_hash).toBe(hashSecret(token))
    expect(JSON.stringify(grantRow)).not.toContain(token)

    const downloadPath = grantUrl.pathname
    const head = await fetch(`${fixture.url}${downloadPath}`, { method: "HEAD" })
    const get = await fetch(`${fixture.url}${downloadPath}`)
    expect(head.status).toBe(200)
    expect(get.status).toBe(200)
    expect(head.headers.get("cache-control")).toBe("private, no-store")
    expect(head.headers.get("content-length")).toBe(String(body.byteLength))
    expect(head.headers.get("x-content-sha256")).toBe(sha256)
    expect(await head.text()).toBe("")
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(body)

    fixture.database.connection.run(
      "DELETE FROM market_group_members WHERE group_id = 'grp_httpactive1' AND employee_id = 'restricted-group'",
    )
    expect((await fetch(`${fixture.url}${downloadPath}`)).status).toBe(404)
    expect((await fetch(`${fixture.url}/v1/private-download/malformed`)).status).toBe(404)

    fixture.database.connection.run(
      "INSERT INTO market_group_members (group_id, employee_id, added_by_employee_id, created_at) VALUES (?, ?, ?, ?)",
      ["grp_httpactive1", "restricted-group", "restricted-owner", now],
    )
    fixture.database.connection.run(
      "UPDATE private_install_grants SET created_at = ?, expires_at = ? WHERE token_hash = ?",
      [now - 10 * 60_000, now, hashSecret(token)],
    )
    expect((await fetch(`${fixture.url}${downloadPath}`, { method: "HEAD" })).status).toBe(404)
    const delistedGrantResponse = await fetch(
      `${fixture.url}/v1/restricted-skills/pub_httpgroup01/install-grants`,
      {
        method: "POST",
        headers: { cookie: users.owner.cookie, origin: webOrigin, "x-csrf-token": users.owner.csrf },
      },
    )
    const delistedGrant = Schema.decodeUnknownSync(SkillMarket.PrivateInstallGrant)(await delistedGrantResponse.json())
    fixture.database.connection.run("UPDATE restricted_publications SET status = 'delisted' WHERE id = 'pub_httpgroup01'")
    expect((await fetch(`${fixture.url}${new URL(delistedGrant.url).pathname}`)).status).toBe(404)
    expect(JSON.stringify(fixture.metrics)).not.toContain(token)
    expect(
      fixture.database.connection
        .query<{ count: number }, []>(
          `SELECT count(*) AS count FROM audit_events
           WHERE before_json LIKE '%skill-market-private%' OR after_json LIKE '%skill-market-private%'`,
        )
        .get()!.count,
    ).toBe(0)

    const publicPackage = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(publicPackage.status).toBe(200)
    expect(publicPackage.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  })

  test("proxies immutable catalog icons without exposing the OSS certificate chain", async () => {
    await using fixture = await marketFixture({ icon: true })
    const pageResponse = await fetch(`${fixture.url}/v1/catalog/skills?page=1&limit=30`)
    const page = Schema.decodeUnknownSync(SkillMarket.Page)(await pageResponse.json())
    const iconUrl = new URL("/v1/catalog/icon", "https://market.example.com")
    iconUrl.searchParams.set("url", page.items[0]!.iconUrl!)
    const icon = await fetch(new URL(`${iconUrl.pathname}${iconUrl.search}`, fixture.url))
    expect(icon.status).toBe(200)
    expect(icon.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await icon.arrayBuffer())).toEqual(fixture.iconBody)

    const head = await fetch(new URL(`${iconUrl.pathname}${iconUrl.search}`, fixture.url), { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
  })

  test("binds Effect catalog headers and body to one acquired revision", async () => {
    const first = sampleSnapshot("effect-a")
    const second = sampleSnapshot("effect-b")
    const catalog: CatalogReader = {
      async index() {
        return { ...first, details: new Map() }
      },
      async list(query, current) {
        const index = current ?? { ...second, details: new Map() }
        return {
          revision: index.revision,
          sourceStatus: index.sourceStatus,
          total: index.items.length,
          page: query.page,
          limit: query.limit,
          items: index.items,
        }
      },
      async facets(current) {
        return (current ?? second).facets
      },
      async detail() {
        return undefined
      },
      async versions() {
        return undefined
      },
      async download() {
        return undefined
      },
    }
    await using fixture = await marketFixture({ catalog })

    const response = await fetch(`${fixture.url}/v1/catalog/skills?page=1&limit=30`)
    const page = Schema.decodeUnknownSync(SkillMarket.Page)(await response.json())

    expect(response.headers.get("x-skill-market-revision")).toBe("effect-a")
    expect(page.revision).toBe("effect-a")
  })

  test("serves verified packages through GET and HEAD with bounded delivery metrics", async () => {
    await using fixture = await marketFixture()
    const get = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(get.status).toBe(200)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(fixture.packageBody)
    expect(get.headers.get("content-type")).toBe("application/zip")
    expect(get.headers.get("content-length")).toBe(String(fixture.packageBody.byteLength))
    expect(get.headers.get("etag")).toBe(`"${fixture.packageSha256}"`)
    expect(get.headers.get("x-content-sha256")).toBe(fixture.packageSha256)
    expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(get.headers.get("content-disposition")).toBe('attachment; filename="skillhub-code-review-1.0.0.zip"')
    expect(get.headers.get("x-content-type-options")).toBe("nosniff")

    const head = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`, { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(head.headers.get("content-type")).toBe("application/zip")
    expect(head.headers.get("content-length")).toBe(String(fixture.packageBody.byteLength))
    expect(head.headers.get("etag")).toBe(`"${fixture.packageSha256}"`)
    expect(head.headers.get("x-content-sha256")).toBe(fixture.packageSha256)
    expect(head.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(head.headers.get("content-disposition")).toBe('attachment; filename="skillhub-code-review-1.0.0.zip"')
    expect(head.headers.get("x-content-type-options")).toBe("nosniff")
    expect(fixture.packageGets).toBe(2)
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          success: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
        },
      },
      {
        skill_market_package_delivery: {
          success: 1,
          source: "skillhub",
          id: "code-review",
          method: "HEAD",
        },
      },
    ])

    fixture.objects.delete(`skill-market/packages/${fixture.packageSha256}.zip`)
    const failed = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(failed.status).toBe(502)
    const failedBody = await failed.text()
    const failedJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(failedBody)
    const problem = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        source: Schema.String,
        id: Schema.String,
        requestId: Schema.String,
      }),
    )(failedJson)
    expect(failedJson).toEqual({
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      source: "skillhub",
      id: "code-review",
      requestId: problem.requestId,
    })
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          success: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
        },
      },
      {
        skill_market_package_delivery: {
          success: 1,
          source: "skillhub",
          id: "code-review",
          method: "HEAD",
        },
      },
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
          phase: "head",
          request_id: problem.requestId,
        },
      },
    ])
    const publicEvidence = `${failedBody}\n${JSON.stringify(fixture.metrics)}`
    expect(publicEvidence).not.toContain("https://attacker.example/never-fetch.zip")
    expect(publicEvidence).not.toContain(fixture.trustedKey)
  })

  test("correlates snapshot delivery failures without exposing dependency details", async () => {
    await using fixture = await marketFixture({ snapshotFailure: true })
    const failed = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(failed.status).toBe(503)
    const failedBody = await failed.text()
    const failedJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(failedBody)
    const problem = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        requestId: Schema.String,
      }),
    )(failedJson)
    expect(failedJson).toEqual({
      code: "market-unavailable",
      message: "Skill 市场暂不可用",
      requestId: problem.requestId,
    })
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
          phase: "snapshot",
          request_id: problem.requestId,
        },
      },
    ])
    expect(`${failedBody}\n${JSON.stringify(fixture.metrics)}`).not.toContain("snapshot unavailable")
  })

  test.each([
    {
      detail: "absent" as const,
      status: 404,
      code: "skill-market-not-found",
      message: "Skill 包不存在",
      phase: "detail",
    },
    {
      detail: "delisted" as const,
      status: 404,
      code: "skill-market-not-found",
      message: "Skill 包不存在",
      phase: "detail",
    },
    {
      detail: "oversize" as const,
      status: 413,
      code: "skill-market-package-too-large",
      message: "Skill 包超过大小限制",
      phase: "declared-size",
    },
  ])("maps $detail packages through the Effect delivery route", async (options) => {
    await using fixture = await marketFixture({ packageDetail: options.detail })
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(response.status).toBe(options.status)
    const responseBody = await response.text()
    const responseJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(responseBody)
    const problem = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        requestId: Schema.String,
        source: Schema.String,
        id: Schema.String,
      }),
    )(responseJson)
    expect(responseJson).toEqual({
      code: options.code,
      message: options.message,
      source: "skillhub",
      id: "code-review",
      requestId: problem.requestId,
    })
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
          phase: options.phase,
          request_id: problem.requestId,
        },
      },
    ])
    expect(fixture.packageHeads).toBe(0)
    expect(fixture.packageGets).toBe(0)
    const publicEvidence = `${responseBody}\n${JSON.stringify(fixture.metrics)}`
    expect(publicEvidence).not.toContain("https://attacker.example/never-fetch.zip")
    expect(publicEvidence).not.toContain(fixture.trustedKey)
  })

  test.each([
    {
      failure: "stored-oversize" as const,
      status: 413,
      code: "skill-market-package-too-large",
      message: "Skill 包超过大小限制",
      phase: "stored-size",
      heads: 1,
      gets: 0,
    },
    {
      failure: "get" as const,
      status: 502,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      phase: "get",
      heads: 1,
      gets: 1,
    },
    {
      failure: "stored-size" as const,
      status: 502,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      phase: "stored-size",
      heads: 1,
      gets: 0,
    },
    {
      failure: "body-size" as const,
      status: 502,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      phase: "body-size",
      heads: 1,
      gets: 1,
    },
    {
      failure: "sha256" as const,
      status: 502,
      code: "skill-market-package-unavailable",
      message: "Skill 包暂不可用",
      phase: "sha256",
      heads: 1,
      gets: 1,
    },
  ])("maps $failure verification failures through the Effect delivery route", async (options) => {
    await using fixture = await marketFixture({ packageFailure: options.failure })
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`)
    expect(response.status).toBe(options.status)
    const responseBody = await response.text()
    const responseJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(responseBody)
    const problem = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        requestId: Schema.String,
        source: Schema.String,
        id: Schema.String,
      }),
    )(responseJson)
    expect(responseJson).toEqual({
      code: options.code,
      message: options.message,
      source: "skillhub",
      id: "code-review",
      requestId: problem.requestId,
    })
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "GET",
          phase: options.phase,
          request_id: problem.requestId,
        },
      },
    ])
    expect(fixture.packageHeads).toBe(options.heads)
    expect(fixture.packageGets).toBe(options.gets)
    const publicEvidence = `${responseBody}\n${JSON.stringify(fixture.metrics)}`
    expect(publicEvidence).not.toContain("https://attacker.example/never-fetch.zip")
    expect(publicEvidence).not.toContain(fixture.trustedKey)
  })

  test.each([
    {
      name: "absent",
      fixture: { packageDetail: "absent" as const },
      status: 404,
      phase: "detail",
    },
    {
      name: "declared oversize",
      fixture: { packageDetail: "oversize" as const },
      status: 413,
      phase: "declared-size",
    },
    {
      name: "GET-stage failure",
      fixture: { packageFailure: "get" as const },
      status: 502,
      phase: "get",
    },
  ])("returns an empty HEAD $name problem with bounded telemetry", async (options) => {
    await using fixture = await marketFixture(options.fixture)
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`, {
      method: "HEAD",
    })
    expect(response.status).toBe(options.status)
    expect(await response.text()).toBe("")
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "HEAD",
          phase: options.phase,
          request_id: expect.any(String),
        },
      },
    ])
    const publicEvidence = JSON.stringify(fixture.metrics)
    expect(publicEvidence).not.toContain("https://attacker.example/never-fetch.zip")
    expect(publicEvidence).not.toContain(fixture.trustedKey)
  })

  test("returns an empty HEAD snapshot problem with bounded telemetry", async () => {
    await using fixture = await marketFixture({ snapshotFailure: true })
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code-review/package`, {
      method: "HEAD",
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toBe("")
    expect(fixture.metrics).toEqual([
      {
        skill_market_package_delivery: {
          failure: 1,
          source: "skillhub",
          id: "code-review",
          method: "HEAD",
          phase: "snapshot",
          request_id: expect.any(String),
        },
      },
    ])
    expect(JSON.stringify(fixture.metrics)).not.toContain("snapshot unavailable")
  })

  test("isolates encoded traversal and never fetches the catalog package URL", async () => {
    const state = { canaryConnections: 0 }
    const canary = createServer((socket) => {
      state.canaryConnections++
      socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      canary.once("error", reject)
      canary.listen(0, "127.0.0.1", resolve)
    })
    const address = canary.address()
    if (!address || typeof address === "string") throw new Error("canary did not bind a TCP port")
    try {
      const packageUrl = `https://127.0.0.1:${address.port}/never-fetch.zip`
      await using valid = await marketFixture({ packageUrl })
      const delivered = await fetch(`${valid.url}/v1/catalog/skills/skillhub/code-review/package`)
      expect(delivered.status).toBe(200)
      expect(state.canaryConnections).toBe(0)
      expect(valid.storageKeys).toEqual([valid.trustedKey, valid.trustedKey])

      await using escaped = await marketFixture({ packageUrl })
      const response = await fetch(`${escaped.url}/v1/catalog/skills/skillhub/%2e%2e%2fprivate/package`)
      expect(response.status).toBe(404)
      const problem = await response.json()
      expect(problem).toEqual({
        code: "skill-market-not-found",
        message: "Skill 包不存在",
        requestId: expect.any(String),
        source: "skillhub",
        id: "../private",
      })
      expect(state.canaryConnections).toBe(0)
      expect(escaped.storageKeys).toEqual([])
      expect(escaped.metrics).toEqual([
        {
          skill_market_package_delivery: {
            failure: 1,
            source: "skillhub",
            id: "../private",
            method: "GET",
            phase: "detail",
            request_id: Schema.decodeUnknownSync(Schema.Struct({ requestId: Schema.String }))(problem).requestId,
          },
        },
      ])
      const publicEvidence = `${JSON.stringify(problem)}\n${JSON.stringify(escaped.metrics)}`
      expect(publicEvidence).not.toContain(packageUrl)
      expect(publicEvidence).not.toContain(escaped.trustedKey)
    } finally {
      await new Promise<void>((resolve, reject) => {
        canary.close((error) => (error ? reject(error) : resolve()))
      })
    }
  })

  test.each(["%", "%ZZ"])("bounds malformed Effect package ID encoding %s", async (id) => {
    await using fixture = await marketFixture()
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/${id}/package`)

    expect([400, 404]).toContain(response.status)
    const body = await response.text()
    expect(body.length).toBeLessThan(1_000)
    expect(body).not.toContain("URIError")
    expect(body).not.toContain("decodeURIComponent")
    expect(body).not.toContain(fixture.trustedKey)
    expect(body).not.toContain("https://attacker.example/never-fetch.zip")
    expect(fixture.storageKeys).toEqual([])
  })

  test("sanitizes schema-valid package identity in production attachment filenames", async () => {
    await using fixture = await marketFixture({ packageID: "code+review", packageVersion: "1.0.0+build" })
    const response = await fetch(`${fixture.url}/v1/catalog/skills/skillhub/code+review/package`)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="skillhub-code_review-1.0.0_build.zip"',
    )
  })

  test("completes login, returns a private session, enforces CSRF, and logs out", async () => {
    await using fixture = await marketFixture()
    const returnTo = "/submissions/new?target=personal"
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`, {
      headers: { origin: webOrigin },
      redirect: "manual",
    })

    expect(login.status).toBe(302)
    expect(login.headers.get("location")).toStartWith("https://sso.example.com/login?")
    expect(login.headers.get("access-control-allow-origin")).toBe(webOrigin)
    expect(login.headers.get("access-control-allow-credentials")).toBe("true")
    expect(login.headers.get("vary")).toContain("Origin")
    expect(login.headers.get("cache-control")).toBe("no-store")
    expect(login.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")

    const session = await loginSession(fixture, login, returnTo)
    const current = await fetch(`${fixture.url}/v1/auth/session`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(current.status).toBe(200)
    expect(await current.json()).toMatchObject({ user: { employeeID: "E123456", displayName: "CONTRIBUTOR" } })

    const preflight = await fetch(`${fixture.url}/v1/auth/session`, {
      method: "OPTIONS",
      headers: {
        origin: webOrigin,
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "x-csrf-token",
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe(webOrigin)
    expect(preflight.headers.get("access-control-allow-methods")).toContain("DELETE")
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-CSRF-Token")

    const rejected = await fetch(`${fixture.url}/v1/auth/session`, {
      method: "DELETE",
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toMatchObject({ code: "csrf-invalid" })

    const logout = await fetch(`${fixture.url}/v1/auth/session`, {
      method: "DELETE",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
      },
    })
    expect(logout.status).toBe(204)
    expect(logout.headers.getSetCookie().join("\n")).toContain("Max-Age=0")

    const loggedOut = await fetch(`${fixture.url}/v1/auth/session`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(await loggedOut.json()).toBeNull()
  })

  test("lets an authenticated Admin publish an audited announcement", async () => {
    await using fixture = await marketFixture()
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fadmin%2Fannouncements`, {
      redirect: "manual",
    })
    const session = await loginSession(fixture, login, "/admin/announcements")
    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, 'admin', ?, ?)",
      ["E123456", "E123456", now],
    )

    const response = await fetch(`${fixture.url}/v1/admin/announcements`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "content-type": "application/json",
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify({
        title: "新功能上线",
        summary: "公告摘要",
        content: "# 公告正文",
      }),
    })

    expect(response.status).toBe(200)
    const announcement = Schema.decodeUnknownSync(SkillMarket.AnnouncementDetail)(await response.json())
    expect(announcement).toMatchObject({ title: "新功能上线", content: "# 公告正文" })
    expect(
      fixture.database.connection
        .query<
          { action: string; object_type: string },
          [string]
        >("SELECT action, object_type FROM audit_events WHERE object_id = ?")
        .get(announcement.id),
    ).toEqual({ action: "announcement-published", object_type: "announcement" })
  })

  test("streams a submission into quarantine and rejects access outside the user's role", async () => {
    await using fixture = await marketFixture()
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fsubmissions`, { redirect: "manual" })
    const session = await loginSession(fixture, login)

    const anonymous = await fetch(`${fixture.url}/v1/submissions`)
    expect(anonymous.status).toBe(401)
    expect(await anonymous.json()).toMatchObject({ code: "unauthenticated" })

    const form = new FormData()
    form.set(
      "metadata",
      JSON.stringify({
        version: "1.0.0",
        displayName: "Safe Skill",
        description: "A safe submitted skill",
        category: "Developer Tools",
        tags: ["review"],
        license: "MIT",
        requiresApiKey: false,
        changeNotes: "Initial submission",
      }),
    )
    form.set(
      "package",
      new Blob(
        [
          makeStoredZip({
            "SKILL.md": "---\nname: safe-skill\ndescription: A safe submitted skill\nlicense: MIT\n---\n# Safe Skill\n",
          }),
        ],
        { type: "application/zip" },
      ),
      "safe-skill.zip",
    )
    const created = await fetch(`${fixture.url}/v1/submissions`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "idempotency-key": "submission-http-test-1",
      },
      body: form,
    })
    expect(created.status).toBe(202)
    const accepted = Schema.decodeUnknownSync(SkillMarketControl.AcceptedSubmission)(await created.json())
    expect(accepted.submission).toMatchObject({ skillID: "safe-skill", status: "validating" })
    expect(fixture.privateWrites).toBeGreaterThan(0)
    expect([...fixture.objects.keys()].some((key) => key.endsWith("/package.zip"))).toBe(true)

    const detail = await fetch(`${fixture.url}/v1/submissions/${accepted.submission.id}`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ id: accepted.submission.id, skillID: "safe-skill" })

    const admin = await fetch(`${fixture.url}/v1/admin/submissions`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(admin.status).toBe(403)
    expect(await admin.json()).toMatchObject({ code: "forbidden" })
  })

  test("serves a published personal package only to its owner and hides it from reviewers", async () => {
    await using fixture = await marketFixture()
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fpersonal`, { redirect: "manual" })
    const session = await loginSession(fixture, login, "/personal")
    const packageBody = makeStoredZip({
      "SKILL.md": "---\nname: personal-helper\ndescription: A private helper\n---\n# Personal Helper\n",
    })
    const form = new FormData()
    form.set(
      "metadata",
      JSON.stringify({
        target: "personal",
        metadata: {
          version: "1.0.0",
          displayName: "Personal Helper",
          description: "A private helper",
          category: "Developer Tools",
          tags: ["private"],
          requiresApiKey: false,
          changeNotes: "Initial personal upload",
        },
      }),
    )
    form.set("package", new Blob([packageBody], { type: "application/zip" }), "personal-helper.zip")
    const created = await fetch(`${fixture.url}/v1/submissions`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "idempotency-key": "personal-http-test-1",
      },
      body: form,
    })
    expect(created.status).toBe(202)
    const accepted = Schema.decodeUnknownSync(SkillMarketControl.AcceptedSubmission)(await created.json())
    expect(accepted.submission).toMatchObject({ target: "personal", status: "validating" })
    fixture.database.connection.run("UPDATE submissions SET status = 'published' WHERE id = ?", [
      accepted.submission.id,
    ])

    const downloaded = await fetch(`${fixture.url}/v1/submissions/${accepted.submission.id}/package`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(downloaded.status).toBe(200)
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(packageBody)
    expect(downloaded.headers.get("cache-control")).toContain("no-store")
    expect(downloaded.headers.get("content-disposition")).toBe('attachment; filename="personal-helper-1.0.0.zip"')

    const head = await fetch(`${fixture.url}/v1/submissions/${accepted.submission.id}/package`, {
      method: "HEAD",
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(head.headers.get("x-content-sha256")).toHaveLength(64)

    fixture.database.transaction((connection) => {
      connection.run("INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)", [
        "E999999",
        "REVIEWER",
        now,
        now,
      ])
      connection.run("INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, ?, ?, ?)", [
        "E999999",
        "reviewer",
        null,
        now,
      ])
      connection.run("UPDATE sessions SET employee_id = ? WHERE employee_id = ?", ["E999999", "E123456"])
    })
    const hiddenPackage = await fetch(`${fixture.url}/v1/submissions/${accepted.submission.id}/package`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(hiddenPackage.status).toBe(404)
    expect(await hiddenPackage.json()).toMatchObject({ code: "not-found" })

    const hiddenReview = await fetch(`${fixture.url}/v1/admin/submissions/${accepted.submission.id}`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(hiddenReview.status).toBe(404)
    expect(await hiddenReview.json()).toMatchObject({ code: "not-found" })
  })

  test("handles personal promotion and reviewed audience-change requests", async () => {
    await using fixture = await marketFixture()
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fpersonal`, { redirect: "manual" })
    const session = await loginSession(fixture, login, "/personal")
    const headers = {
      cookie: session.cookie,
      origin: webOrigin,
      "x-csrf-token": session.csrf,
      "content-type": "application/json",
    }
    const createGroup = async (name: string) => {
      const response = await fetch(`${fixture.url}/v1/groups`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      })
      expect(response.status).toBe(200)
      return Schema.decodeUnknownSync(SkillMarketControl.MarketGroup)(await response.json())
    }
    const firstGroup = await createGroup("Promotion Group")
    const secondGroup = await createGroup("Audience Change Group")

    const body = makeStoredZip({
      "SKILL.md": "---\nname: shared-personal\ndescription: A promoted helper\n---\n# Shared Personal\n",
    })
    const form = new FormData()
    form.set(
      "metadata",
      JSON.stringify({
        target: "personal",
        metadata: {
          version: "1.0.0",
          displayName: "Shared Personal",
          description: "A promoted helper",
          category: "Developer Tools",
          tags: ["private"],
          requiresApiKey: false,
          changeNotes: "Initial personal upload",
        },
      }),
    )
    form.set("package", new Blob([body], { type: "application/zip" }), "shared-personal.zip")
    const createdResponse = await fetch(`${fixture.url}/v1/submissions`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "idempotency-key": "sharing-source-http",
      },
      body: form,
    })
    const source = Schema.decodeUnknownSync(SkillMarketControl.AcceptedSubmission)(await createdResponse.json())
    completeStoredValidation(fixture, source.submission.id)

    const promotionResponse = await fetch(`${fixture.url}/v1/submissions/${source.submission.id}/promotions`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "sharing-promotion-http" },
      body: JSON.stringify({
        expectedVersion: 2,
        target: "groups",
        audience: { scope: "groups", groupIDs: [firstGroup.id] },
      }),
    })
    expect(promotionResponse.status).toBe(202)
    const promotion = Schema.decodeUnknownSync(SkillMarketControl.AcceptedSubmission)(await promotionResponse.json())
    expect(promotion.submission).toMatchObject({
      target: "groups",
      audience: { scope: "groups", groupIDs: [firstGroup.id] },
      status: "validating",
    })
    completeStoredValidation(fixture, promotion.submission.id)
    seedHttpRestrictedPublication(fixture, promotion.submission.id)

    const changeResponse = await fetch(`${fixture.url}/v1/submissions/${promotion.submission.id}/audience-changes`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "sharing-audience-http" },
      body: JSON.stringify({
        expectedVersion: 3,
        target: "groups",
        audience: { scope: "groups", groupIDs: [secondGroup.id] },
      }),
    })
    expect(changeResponse.status).toBe(202)
    expect(
      Schema.decodeUnknownSync(SkillMarketControl.AcceptedSubmission)(await changeResponse.json()).submission,
    ).toMatchObject({
      target: "groups",
      audience: { scope: "groups", groupIDs: [secondGroup.id] },
      status: "pending_review",
    })
  })

  test("preassigns roles over HTTP and reports duplicate assignments clearly", async () => {
    await using fixture = await marketFixture()
    fixture.database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
      ["E123456", "E123456", now, now],
    )
    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, ?, ?, ?)",
      ["E123456", "admin", null, now],
    )
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fadmin%2Froles`, { redirect: "manual" })
    const session = await loginSession(fixture, login, "/admin/roles")
    const request = () =>
      fetch(`${fixture.url}/v1/admin/roles`, {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin: webOrigin,
          "x-csrf-token": session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ employeeID: "future-user", role: "reviewer" }),
      })

    const assigned = await request()
    expect(assigned.status).toBe(200)
    expect(await assigned.json()).toMatchObject({
      user: { employeeID: "future-user", displayName: "future-user" },
      role: "reviewer",
    })

    const duplicate = await request()
    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({
      code: "invalid-request",
      message: "该用户已拥有此角色",
      requestId: expect.any(String),
    })
  })

  test("returns durable SkillHub import progress to an authenticated admin", async () => {
    await using fixture = await marketFixture()
    fixture.database.connection.run(
      "INSERT INTO users (employee_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
      ["E123456", "E123456", now, now],
    )
    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, ?, ?, ?)",
      ["E123456", "admin", null, now],
    )
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fadmin%2Fskillhub`, { redirect: "manual" })
    const session = await loginSession(fixture, login, "/admin/skillhub")
    const response = await fetch(`${fixture.url}/v1/admin/skillhub-import`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })

    expect(response.status).toBe(200)
    expect(Schema.decodeUnknownSync(SkillMarketControl.SkillHubImportProgress)(await response.json())).toMatchObject({
      pending: 0,
      running: 0,
      mirrored: 0,
      retryWait: 0,
      rejected: 0,
    })
  })

  test("returns TRACE evaluation progress only to an authenticated admin", async () => {
    await using fixture = await marketFixture()

    const anonymous = await fetch(`${fixture.url}/v1/admin/skillhub-evaluation`, { headers: { origin: webOrigin } })
    expect(anonymous.status).toBe(401)

    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fadmin%2Fskillhub`, { redirect: "manual" })
    const session = await loginSession(fixture, login, "/admin/skillhub")
    const member = await fetch(`${fixture.url}/v1/admin/skillhub-evaluation`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(member.status).toBe(403)

    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, ?, ?, ?)",
      ["E123456", "admin", null, now],
    )
    const admin = await fetch(`${fixture.url}/v1/admin/skillhub-evaluation`, {
      headers: { cookie: session.cookie, origin: webOrigin },
    })
    expect(admin.status).toBe(200)
    expect(Schema.decodeUnknownSync(SkillMarketControl.SkillHubEvaluationProgress)(await admin.json())).toMatchObject({
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    })
  })

  test("returns bounded stable errors for malformed control requests without leaking private data", async () => {
    await using fixture = await marketFixture()
    const login = await fetch(`${fixture.url}/v1/auth/login?returnTo=%2Fadmin`, { redirect: "manual" })
    const session = await loginSession(fixture, login, "/admin")
    fixture.database.connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, 'reviewer', ?, ?)",
      ["E123456", "E123456", now],
    )

    const malformedJson = await fetch(`${fixture.url}/v1/admin/submissions/sub_abcdefgh/decision`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: '{"expectedVersion":',
    })
    expect(malformedJson.status).toBe(400)
    const jsonBody = await malformedJson.text()
    expect(jsonBody).toContain('"code":"invalid-request"')
    expect(jsonBody).not.toContain("SyntaxError")
    expect(jsonBody).not.toContain("skill-market-private")

    const malformedMultipart = await fetch(`${fixture.url}/v1/submissions`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "idempotency-key": "malformed-multipart-1",
        "content-type": "multipart/form-data; boundary=broken",
      },
      body: "not-a-multipart-body",
    })
    expect(malformedMultipart.status).toBe(400)
    expect(await malformedMultipart.json()).toMatchObject({ code: "invalid-request" })

    const unsupported = await fetch(`${fixture.url}/v1/admin/submissions/sub_abcdefgh/decision`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: webOrigin,
        "x-csrf-token": session.csrf,
        "content-type": "text/plain",
      },
      body: "not-json",
    })
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toMatchObject({ code: "invalid-request" })

    const evilPreflight = await fetch(`${fixture.url}/v1/admin/roles`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    })
    expect(evilPreflight.status).toBe(204)
    expect(evilPreflight.headers.has("access-control-allow-origin")).toBe(false)
  })
})

async function loginSession(
  fixture: Awaited<ReturnType<typeof marketFixture>>,
  login: Response,
  returnTo = "/submissions",
) {
  const authorization = new URL(login.headers.get("location")!)
  const callback = new URL(authorization.searchParams.get("redirect_url")!)
  const response = await fetch(`${fixture.url}${callback.pathname}?access_token=sso-token`, {
    headers: { origin: webOrigin },
    redirect: "manual",
  })
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(new URL(returnTo.slice(1), webBaseUrl).href)
  const setCookies = response.headers.getSetCookie()
  expect(setCookies).toHaveLength(2)
  expect(setCookies.every((value) => value.includes("Max-Age=43200"))).toBe(true)
  const cookies = setCookies.map((value) => value.split(";", 1)[0])
  const csrf = cookies.find((value) => value.startsWith("ruying_market_csrf="))?.split("=", 2)[1]
  expect(csrf).toHaveLength(43)
  if (!csrf) throw new Error("login did not set a CSRF cookie")
  return { cookie: cookies.join("; "), csrf }
}

async function marketFixture(
  options: {
    snapshotFailure?: boolean
    catalog?: CatalogReader
    packageDetail?: "present" | "absent" | "delisted" | "oversize"
    packageFailure?: "stored-oversize" | "get" | "stored-size" | "body-size" | "sha256"
    packageUrl?: string
    packageID?: string
    packageVersion?: string
    icon?: boolean
    publicCommunityID?: string
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "ruying-skill-market-control-http-"))
  directories.push(directory)
  const database = await openDatabase({
    databasePath: join(directory, "market.db"),
    migrationBackupDirectory: join(directory, "backups"),
  })
  const security = createSecurity({
    database,
    webOrigin,
    sessionIdleMilliseconds: 2 * 60 * 60 * 1_000,
    sessionAbsoluteMilliseconds: 12 * 60 * 60 * 1_000,
    now: () => now,
  })
  const provisioningFetch: typeof fetch = Object.assign(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ status: "ready", key: "must-not-leak", tokenName: "E123456-CONTRIBUTOR" }),
    { preconnect: fetch.preconnect },
  )
  const auth = createAuth({
    database,
    security,
    ssoLoginUrl: "https://sso.example.com/login",
    adminApiBaseUrl: "https://admin.example.com",
    apiPublicUrl: "http://127.0.0.1:4210",
    sessionCookieName: "ruying_market_session",
    cookieSecure: false,
    loginAttemptMilliseconds: 5 * 60 * 1_000,
    sessionAbsoluteMilliseconds: 12 * 60 * 60 * 1_000,
    now: () => now,
    fetch: provisioningFetch,
  })
  const packageBody = new TextEncoder().encode("verified package from Effect HttpApi")
  const packageSha256 = new Bun.CryptoHasher("sha256").update(packageBody).digest("hex")
  const trustedKey = `skill-market/packages/${packageSha256}.zip`
  const iconBody = new TextEncoder().encode("verified icon from Effect catalog")
  const iconSha256 = new Bun.CryptoHasher("sha256").update(iconBody).digest("hex")
  const iconKey = `skill-market/icons/${iconSha256}.png`
  const storedPackageBody =
    options.packageFailure === "body-size"
      ? new Uint8Array([...packageBody, 0])
      : options.packageFailure === "sha256"
        ? packageBody.map((value, index) => (index === 0 ? value ^ 1 : value))
        : packageBody
  const objects = new Map<string, Uint8Array>([
    [trustedKey, storedPackageBody],
    ...(options.icon ? ([[iconKey, iconBody]] as const) : []),
  ])
  const metrics: Array<Readonly<Record<string, unknown>>> = []
  const state = { privateWrites: 0, packageHeads: 0, packageGets: 0, storageKeys: [] as string[] }
  const store: PrivateObjectStore = {
    async put(key, body) {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)
    },
    async get(key) {
      state.storageKeys.push(key)
      const body = objects.get(key)
      if (!body) throw new Error("object is missing")
      if (key === trustedKey) state.packageGets++
      if (key === trustedKey && options.packageFailure === "get") throw new Error("GET dependency sentinel")
      return body
    },
    async head(key) {
      state.storageKeys.push(key)
      const body = objects.get(key)
      if (!body) throw new Error("object is missing")
      if (key === trustedKey) state.packageHeads++
      if (key === trustedKey && options.packageFailure === "stored-oversize")
        return { size: MAX_CATALOG_PACKAGE_SIZE + 1 }
      if (key === trustedKey && options.packageFailure === "stored-size") return { size: packageBody.byteLength + 1 }
      if (key === trustedKey && options.packageFailure === "body-size") return { size: packageBody.byteLength }
      return { size: body.byteLength }
    },
    async putPrivate(key, body) {
      state.privateWrites++
      objects.set(key, new Uint8Array(await new Blob(await Array.fromAsync(body)).arrayBuffer()))
    },
    async copy(source, target) {
      const body = objects.get(source)
      if (!body) throw new Error("object is missing")
      objects.set(target, body.slice())
    },
    async delete(key) {
      objects.delete(key)
    },
  }
  const submissions = createSubmissions({ database, now: () => now })
  const groups = createGroups({ database, now: () => now })
  const moderation = createModeration({ database, security, now: () => now })
  const skillhubImportAdmin = createSkillHubImportAdmin({
    database,
    security,
    imports: createSkillHubImportStore({ database, now: () => now }),
    evaluations: createSkillHubEvaluationStore({ database, now: () => now }),
    now: () => now,
  })
  const restrictedCatalog = createRestrictedCatalog({
    database,
    apiPublicUrl: "https://market.example",
    now: () => now,
  })
  const installGrants = createInstallGrants({
    database,
    restrictedCatalog,
    apiPublicUrl: "https://market.example",
    now: () => now,
  })
  const baseSnapshot = sampleSnapshot()
  baseSnapshot.details.delete("skillhub:code-review")
  baseSnapshot.details.set(
    `skillhub:${options.packageID ?? "code-review"}`,
    sampleDetail({
      id: options.packageID ?? "code-review",
      delisted: options.packageDetail === "delisted",
      version: options.packageVersion ?? "1.0.0",
      package: {
        ...sampleDetail().package,
        url: options.packageUrl ?? "https://attacker.example/never-fetch.zip",
        sha256: packageSha256,
        size: options.packageDetail === "oversize" ? MAX_CATALOG_PACKAGE_SIZE + 1 : packageBody.byteLength,
      },
    }),
  )
  if (options.packageDetail === "absent") baseSnapshot.details.delete(`skillhub:${options.packageID ?? "code-review"}`)
  if (options.publicCommunityID) {
    const publicCommunity = sampleDetail({
      id: options.publicCommunityID,
      source: "community",
      sourceUrl: `https://market.example/skills/community/${options.publicCommunityID}`,
      publicDetailUrl: `https://market.example/skills/community/${options.publicCommunityID}`,
    })
    baseSnapshot.items.push(publicCommunity)
    baseSnapshot.details.set(`community:${options.publicCommunityID}`, publicCommunity)
  }
  const snapshot = options.icon
    ? {
        ...baseSnapshot,
        items: baseSnapshot.items.map((item) => ({
          ...item,
          iconUrl: `https://oss.example.com/skill-market/icons/${iconSha256}.png`,
        })),
        details: new Map(
          Array.from(baseSnapshot.details, ([entryKey, detail]) => [
            entryKey,
            { ...detail, iconUrl: `https://oss.example.com/skill-market/icons/${iconSha256}.png` },
          ]),
        ),
      }
    : baseSnapshot
  const web = createMarketWebHandler({
    catalog:
      options.catalog ??
      sampleCatalogReader(
        snapshot,
        options.snapshotFailure
          ? () => {
              throw new Error("snapshot unavailable with private dependency detail")
            }
          : undefined,
      ),
    restrictedCatalog,
    installGrants,
    announcements: createAnnouncements({ database, now: () => now }),
    auth,
    security,
    submissions,
    personalTrash: createPersonalTrash({ database, store, now: () => now }),
    moderation,
    expertPackages: createExpertPackages({ database, baseUrl: "https://api.skillhub.cn" }),
    favorites: createFavorites({ database, now: () => now }),
    groups,
    skillhubImportAdmin,
    store,
    privatePrefix: "skill-market-private",
    publicPrefix: "skill-market",
    publicBaseUrl: "https://oss.example.com/skill-market/",
    webOrigin,
    webBaseUrl,
    sessionCookieName: "ruying_market_session",
    cookieSecure: false,
    sessionCookieMaxAgeSeconds: 12 * 60 * 60,
    emit: (metric) => metrics.push(metric),
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request) })
  return {
    url: server.url.origin,
    database,
    submissions,
    objects,
    metrics,
    packageBody,
    packageSha256,
    iconBody,
    trustedKey,
    storageKeys: state.storageKeys,
    get packageHeads() {
      return state.packageHeads
    },
    get packageGets() {
      return state.packageGets
    },
    get privateWrites() {
      return state.privateWrites
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
      await web.dispose()
      database.close()
    },
  }
}

function completeStoredValidation(fixture: Awaited<ReturnType<typeof marketFixture>>, submissionID: string) {
  const revision = fixture.database.connection
    .query<
      { package_sha256: string; package_size: number },
      [string]
    >("SELECT package_sha256, package_size FROM submission_revisions WHERE submission_id = ? AND revision_number = 1")
    .get(submissionID)!
  return fixture.submissions.completeValidation({
    submissionID,
    revision: 1,
    manifest: { packageSha256: revision.package_sha256, packageSize: revision.package_size, files: [] },
    scan: { risk: "safe", reasons: [], evidence: [], scannedAt: new Date(now).toISOString() },
    validationIssues: [],
  })
}

function seedHttpRestrictedPublication(fixture: Awaited<ReturnType<typeof marketFixture>>, submissionID: string) {
  fixture.database.transaction((connection) => {
    connection.run("UPDATE submissions SET status = 'published', version = 3 WHERE id = ?", [submissionID])
    connection.run(
      `INSERT INTO restricted_publications
        (id, submission_id, skill_id, owner_employee_id, version, scope, package_key, package_sha256,
         package_size, metadata_json, status, row_version, created_at, updated_at)
       SELECT 'pub_http12345678', submissions.id, submissions.skill_id, submissions.owner_employee_id,
              submissions.target_version, submissions.target_scope, submission_revisions.private_package_key,
              submission_revisions.package_sha256, submission_revisions.package_size,
              submission_revisions.metadata_json, 'published', 1, ?, ?
       FROM submissions
       INNER JOIN submission_revisions
         ON submission_revisions.submission_id = submissions.id
        AND submission_revisions.revision_number = submissions.current_revision
       WHERE submissions.id = ?`,
      [now, now, submissionID],
    )
    connection.run(
      `INSERT INTO restricted_publication_groups (publication_id, group_id)
       SELECT 'pub_http12345678', group_id FROM submission_group_targets WHERE submission_id = ?`,
      [submissionID],
    )
  })
}

function seedHttpSession(
  connection: Database,
  employeeID: string,
  departmentID: string,
  roles: ReadonlyArray<"contributor" | "reviewer" | "admin"> = [],
) {
  const sessionToken = `session-${employeeID}`
  const csrf = new Bun.CryptoHasher("sha256").update(`csrf-${employeeID}`).digest("base64url")
  connection.run(
    `INSERT INTO users (employee_id, display_name, department_id, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?)`,
    [employeeID, employeeID, departmentID, now, now],
  )
  roles.forEach((role) =>
    connection.run(
      "INSERT INTO role_assignments (employee_id, role, created_by, created_at) VALUES (?, ?, ?, ?)",
      [employeeID, role, employeeID, now],
    ),
  )
  connection.run(
    `INSERT INTO sessions
      (session_hash, employee_id, csrf_hash, created_at, last_activity_at, absolute_expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [hashSecret(sessionToken), employeeID, hashSecret(csrf), now, now, now + 12 * 60 * 60_000],
  )
  return { cookie: `ruying_market_session=${sessionToken}; ruying_market_csrf=${csrf}`, csrf }
}

function seedCatalogPublication(
  connection: Database,
  input: {
    readonly id: string
    readonly submissionID: string
    readonly skillID: string
    readonly scope: "groups" | "department"
    readonly groupID?: string
    readonly departmentID?: string
    readonly key: string
    readonly sha256: string
    readonly size: number
    readonly status?: "published" | "delisted"
  },
) {
  const metadata = {
    version: "1.0.0",
    displayName: input.skillID,
    description: `${input.skillID} description`,
    category: "Developer Tools",
    tags: ["restricted"],
    requiresApiKey: false,
    changeNotes: "Initial release",
  }
  connection.run(
    `INSERT INTO submissions
      (id, skill_id, owner_employee_id, target_version, target_scope, target_department_id,
       status, current_revision, version, created_at, updated_at)
     VALUES (?, ?, 'restricted-owner', '1.0.0', ?, ?, 'published', 1, 1, ?, ?)`,
    [input.submissionID, input.skillID, input.scope, input.departmentID ?? null, now, now],
  )
  connection.run(
    `INSERT INTO submission_revisions
      (submission_id, revision_number, private_package_key, package_sha256, package_size, metadata_json,
       manifest_json, scan_json, validation_errors_json, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    [
      input.submissionID,
      input.key,
      input.sha256,
      input.size,
      JSON.stringify(metadata),
      JSON.stringify({ packageSha256: input.sha256, packageSize: input.size, files: [] }),
      JSON.stringify({ risk: "safe", reasons: [], evidence: [], scannedAt: new Date(now).toISOString() }),
      now,
    ],
  )
  connection.run(
    `INSERT INTO restricted_publications
      (id, submission_id, skill_id, owner_employee_id, version, scope, department_id, package_key,
       package_sha256, package_size, metadata_json, status, row_version, created_at, updated_at)
     VALUES (?, ?, ?, 'restricted-owner', '1.0.0', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      input.id,
      input.submissionID,
      input.skillID,
      input.scope,
      input.departmentID ?? null,
      input.key,
      input.sha256,
      input.size,
      JSON.stringify(metadata),
      input.status ?? "published",
      now,
      now,
    ],
  )
  if (input.groupID)
    connection.run("INSERT INTO restricted_publication_groups (publication_id, group_id) VALUES (?, ?)", [
      input.id,
      input.groupID,
    ])
}
