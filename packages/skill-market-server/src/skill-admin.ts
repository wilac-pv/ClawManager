import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Option, Schema } from "effect"
import type { Connection, MarketDatabase } from "./store"
import { SkillMarketSecurityError, type MarketSecurity, type Principal } from "./security"
import type { CatalogReader } from "./catalog-reader"
import { key } from "./catalog"
import { enqueueCatalogRebuild, insertAudit } from "./moderation-audit"

interface SkillAdminOptions {
  readonly database: MarketDatabase
  readonly security: MarketSecurity
  readonly catalog: CatalogReader
  readonly now?: () => number
}

interface SkillOverrideRow {
  readonly skill_id: string
  readonly source: string
  readonly featured: boolean | null
  readonly hidden: boolean
  readonly hidden_reason: string | null
  readonly category_override: string | null
  readonly updated_by: string
  readonly updated_at: number
}

interface HiddenCategoryRow {
  readonly category: string
  readonly hidden_reason: string | null
  readonly updated_by: string
  readonly updated_at: number
}

export class SkillAdmin {
  constructor(private readonly options: SkillAdminOptions) {}

  async list(principal: Principal, query: SkillMarketControl.SkillAdminListQuery) {
    this.options.security.requireAdmin(principal)
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.SkillAdminListQuery)(query)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "skill admin list query is invalid")
    const index = await this.options.catalog.index()
    const now = this.options.now?.() ?? Date.now()
    const { overrides, hiddenCategories } = await this.options.database.read(async (connection) => ({
      overrides: await loadOverrides(connection),
      hiddenCategories: await loadHiddenCategories(connection),
    }))
    const keyword = decoded.value.query?.trim().toLocaleLowerCase()
    const hiddenCategorySet = new Set(hiddenCategories.map((row) => row.category))
    const items = index.items
      .map((summary) => applyOverride(summary, overrides.get(key(summary.source, summary.id))))
      .filter((item) => !hiddenCategorySet.has(item.categories[0] ?? ""))
      .filter((item) => !decoded.value.source || item.source === decoded.value.source)
      .filter((item) => !decoded.value.category || item.categories.includes(decoded.value.category!))
      .filter((item) => decoded.value.featured === undefined || item.featured === decoded.value.featured)
      .filter((item) => decoded.value.hidden === undefined || item.hidden === decoded.value.hidden)
      .filter(
        (item) =>
          !keyword ||
          `${item.name}\n${item.description}\n${item.categories.join(" ")}\n${item.tags.join(" ")}\n${item.aliases?.join(" ") ?? ""}`
            .toLocaleLowerCase()
            .includes(keyword),
      )
      .toSorted((left, right) => {
        const nameCompare = left.name.localeCompare(right.name)
        return nameCompare !== 0 ? nameCompare : key(left.source, left.id).localeCompare(key(right.source, right.id))
      })
    const page = decoded.value.page ?? 1
    const limit = decoded.value.limit ?? 30
    const start = (page - 1) * limit
    const pageItems = items.slice(start, start + limit).map((summary) => toSkillAdminItem(summary, overrides))
    return Schema.decodeUnknownSync(SkillMarketControl.SkillAdminPage)({
      total: items.length,
      page,
      limit,
      items: pageItems,
    })
  }

  async hiddenCategories(principal: Principal) {
    this.options.security.requireAdmin(principal)
    const rows = await this.options.database.read(async (connection) => loadHiddenCategories(connection))
    return Schema.decodeUnknownSync(SkillMarketControl.HiddenCategoryList)({
      items: rows.map((row) => ({
        category: row.category,
        hiddenReason: row.hidden_reason ?? undefined,
        updatedBy: row.updated_by,
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
    })
  }

  async update(principal: Principal, source: SkillMarket.Source, skillID: string, input: SkillMarketControl.SkillAdminEditInput) {
    this.options.security.requireAdmin(principal)
    if (!Schema.is(SkillMarket.Source)(source) || !Schema.is(SkillMarketControl.SubmissionSummary.fields.skillID)(skillID))
      throw new SkillMarketSecurityError("invalid-request", "skill admin update target is invalid")
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.SkillAdminEditInput)(input)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "skill admin update payload is invalid")
    const now = this.options.now?.() ?? Date.now()
    if (source === "community") {
      return this.updateCommunity(principal, skillID, decoded.value, now)
    }
    return this.updateExternal(principal, source, skillID, decoded.value, now)
  }

  async delist(principal: Principal, source: SkillMarket.Source, skillID: string, input: SkillMarketControl.ReasonInput) {
    return this.setHidden(principal, source, skillID, input, true)
  }

  async restore(principal: Principal, source: SkillMarket.Source, skillID: string, input: SkillMarketControl.ReasonInput) {
    return this.setHidden(principal, source, skillID, input, false)
  }

  async delistByCategory(principal: Principal, input: SkillMarketControl.SkillAdminCategoryActionInput) {
    this.options.security.requireAdmin(principal)
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.SkillAdminCategoryActionInput)(input)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "category action input is invalid")
    const now = this.options.now?.() ?? Date.now()
    await this.options.database.transaction(async (connection) => {
      await connection.run(
        `INSERT INTO skill_overrides (skill_id, source, featured, hidden, hidden_reason, category_override, updated_by, updated_at)
         SELECT DISTINCT skill_id, source, NULL, false, NULL, NULL, ?, ?
         FROM skill_overrides
         WHERE source = '__none__' AND skill_id = '__none__'`,
        [principal.session.user.employeeID, now],
      )
      await connection.run(
        `INSERT INTO hidden_categories (category, hidden_reason, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(category) DO UPDATE SET hidden_reason = excluded.hidden_reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [decoded.value.category, decoded.value.reason ?? null, principal.session.user.employeeID, now],
      )
      await enqueueCatalogRebuild(connection, now)
      await insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "category-hidden",
        objectType: "community_skill",
        objectID: decoded.value.category,
        after: { category: decoded.value.category, reason: decoded.value.reason },
        now,
      })
    })
  }

  async restoreByCategory(principal: Principal, input: SkillMarketControl.SkillAdminCategoryActionInput) {
    this.options.security.requireAdmin(principal)
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.SkillAdminCategoryActionInput)(input)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "category action input is invalid")
    const now = this.options.now?.() ?? Date.now()
    await this.options.database.transaction(async (connection) => {
      await connection.run("DELETE FROM hidden_categories WHERE category = ?", [decoded.value.category])
      await enqueueCatalogRebuild(connection, now)
      await insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "category-shown",
        objectType: "community_skill",
        objectID: decoded.value.category,
        after: { category: decoded.value.category },
        now,
      })
    })
  }

  private async setHidden(
    principal: Principal,
    source: SkillMarket.Source,
    skillID: string,
    input: SkillMarketControl.ReasonInput,
    hidden: boolean,
  ) {
    this.options.security.requireAdmin(principal)
    if (!Schema.is(SkillMarket.Source)(source) || !Schema.is(SkillMarketControl.SubmissionSummary.fields.skillID)(skillID))
      throw new SkillMarketSecurityError("invalid-request", "skill admin status target is invalid")
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.ReasonInput)(input)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "skill admin status payload is invalid")
    const now = this.options.now?.() ?? Date.now()
    if (source === "community") {
      return this.setCommunityHidden(principal, skillID, decoded.value, hidden, now)
    }
    return this.setExternalHidden(principal, source, skillID, decoded.value, hidden, now)
  }

  private async updateCommunity(
    principal: Principal,
    skillID: string,
    input: SkillMarketControl.SkillAdminEditInput,
    now: number,
  ) {
    const { featured, category } = input
    if (featured === undefined && category === undefined)
      throw new SkillMarketSecurityError("invalid-request", "community skill update requires at least one field")
    await this.options.database.transaction(async (connection) => {
      const skill = await connection.get<{ version: number }>(
        "SELECT version FROM community_skills WHERE skill_id = ?",
        [skillID],
      )
      if (!skill) throw new SkillMarketSecurityError("not-found", "community skill was not found")
      if (input.expectedVersion !== undefined && skill.version !== input.expectedVersion)
        throw new SkillMarketSecurityError("submission-conflict", "community skill version no longer matches")
      const submission = await connection.get<{ id: string; metadata_json: string }>(
        "SELECT id, metadata_json FROM submissions WHERE skill_id = ? AND status = 'published' AND target_scope = 'company' ORDER BY created_at DESC LIMIT 1",
        [skillID],
      )
      if (!submission) throw new SkillMarketSecurityError("not-found", "published community submission was not found")
      const metadata = JSON.parse(submission.metadata_json) as Record<string, unknown>
      if (featured !== undefined) metadata.featured = featured
      if (category !== undefined) metadata.categories = [category]
      await connection.run(
        "UPDATE submissions SET metadata_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
        [JSON.stringify(metadata), now, submission.id],
      )
      await connection.run(
        "UPDATE community_skills SET version = version + 1, updated_at = ? WHERE skill_id = ?",
        [now, skillID],
      )
      await enqueueCatalogRebuild(connection, now)
      await insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "skill-updated",
        objectType: "community_skill",
        objectID: skillID,
        after: { featured, category, version: skill.version + 1 },
        now,
      })
    })
    return this.getItem(principal, "community", skillID)
  }

  private async updateExternal(
    principal: Principal,
    source: Exclude<SkillMarket.Source, "community">,
    skillID: string,
    input: SkillMarketControl.SkillAdminEditInput,
    now: number,
  ) {
    const { featured, hidden, hiddenReason, category } = input
    if (featured === undefined && hidden === undefined && category === undefined)
      throw new SkillMarketSecurityError("invalid-request", "skill override update requires at least one field")
    await this.options.database.transaction(async (connection) => {
      const existing = await connection.get<SkillOverrideRow>(
        "SELECT * FROM skill_overrides WHERE source = ? AND skill_id = ?",
        [source, skillID],
      )
      const nextFeatured = featured ?? existing?.featured ?? null
      const nextHidden = hidden ?? existing?.hidden ?? false
      const nextHiddenReason = hiddenReason ?? existing?.hidden_reason ?? null
      const nextCategory = category ?? existing?.category_override ?? null
      if (existing) {
        await connection.run(
          `UPDATE skill_overrides
           SET featured = ?, hidden = ?, hidden_reason = ?, category_override = ?, updated_by = ?, updated_at = ?
           WHERE source = ? AND skill_id = ?`,
          [nextFeatured, nextHidden, nextHiddenReason, nextCategory, principal.session.user.employeeID, now, source, skillID],
        )
      } else {
        await connection.run(
          `INSERT INTO skill_overrides (skill_id, source, featured, hidden, hidden_reason, category_override, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [skillID, source, nextFeatured, nextHidden, nextHiddenReason, nextCategory, principal.session.user.employeeID, now],
        )
      }
      await enqueueCatalogRebuild(connection, now)
      await insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: nextHidden ? "skill-hidden" : "skill-shown",
        objectType: "community_skill",
        objectID: `${source}:${skillID}`,
        before: existing
          ? { featured: existing.featured, hidden: existing.hidden, category: existing.category_override }
          : undefined,
        after: { featured: nextFeatured, hidden: nextHidden, hiddenReason: nextHiddenReason, category: nextCategory },
        now,
      })
    })
    return this.getItem(principal, source, skillID)
  }

  private async setCommunityHidden(
    principal: Principal,
    skillID: string,
    input: SkillMarketControl.ReasonInput,
    hidden: boolean,
    now: number,
  ) {
    await this.options.database.transaction(async (connection) => {
      const skill = await connection.get<{ public_status: SkillMarketControl.PublicStatus | null; version: number }>(
        "SELECT public_status, version FROM community_skills WHERE skill_id = ?",
        [skillID],
      )
      if (!skill?.public_status) throw new SkillMarketSecurityError("not-found", "published community skill was not found")
      if (input.expectedVersion !== undefined && skill.version !== input.expectedVersion)
        throw new SkillMarketSecurityError("submission-conflict", "community skill version no longer matches")
      const expectedStatus = hidden ? "published" : "delisted"
      if (skill.public_status !== expectedStatus)
        throw new SkillMarketSecurityError("submission-conflict", "community skill cannot change to this status")
      await connection.run(
        "UPDATE community_skills SET public_status = ?, delist_reason = ?, version = version + 1, updated_at = ? WHERE skill_id = ?",
        [hidden ? "delisted" : "published", hidden ? input.reason : null, now, skillID],
      )
      await enqueueCatalogRebuild(connection, now)
      await insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: hidden ? "skill-hidden" : "skill-shown",
        objectType: "community_skill",
        objectID: skillID,
        before: { status: skill.public_status, version: skill.version },
        after: { status: hidden ? "delisted" : "published", version: skill.version + 1, reason: input.reason },
        now,
      })
    })
    return this.getItem(principal, "community", skillID)
  }

  private async setExternalHidden(
    principal: Principal,
    source: Exclude<SkillMarket.Source, "community">,
    skillID: string,
    input: SkillMarketControl.ReasonInput,
    hidden: boolean,
    now: number,
  ) {
    await this.options.database.transaction(async (connection) => {
      const existing = await connection.get<SkillOverrideRow>(
        "SELECT * FROM skill_overrides WHERE source = ? AND skill_id = ?",
        [source, skillID],
      )
      const nextHiddenReason = hidden ? input.reason : null
      if (existing) {
        if (existing.hidden === hidden)
          throw new SkillMarketSecurityError("submission-conflict", "skill override already has this status")
        await connection.run(
          `UPDATE skill_overrides
           SET hidden = ?, hidden_reason = ?, updated_by = ?, updated_at = ?
           WHERE source = ? AND skill_id = ?`,
          [hidden, nextHiddenReason, principal.session.user.employeeID, now, source, skillID],
        )
      } else {
        await connection.run(
          `INSERT INTO skill_overrides (skill_id, source, featured, hidden, hidden_reason, category_override, updated_by, updated_at)
           VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)`,
          [skillID, source, hidden, nextHiddenReason, principal.session.user.employeeID, now],
        )
      }
      await enqueueCatalogRebuild(connection, now)
      await insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: hidden ? "skill-hidden" : "skill-shown",
        objectType: "community_skill",
        objectID: `${source}:${skillID}`,
        before: existing ? { hidden: existing.hidden, hiddenReason: existing.hidden_reason } : undefined,
        after: { hidden, hiddenReason: nextHiddenReason },
        now,
      })
    })
    return this.getItem(principal, source, skillID)
  }

  private async getItem(principal: Principal, source: SkillMarket.Source, skillID: string) {
    const page = await this.list(principal, { query: skillID, page: 1, limit: 1 })
    const item = page.items[0]
    if (!item) throw new SkillMarketSecurityError("not-found", "skill was not found after update")
    return item
  }
}

export function createSkillAdmin(options: SkillAdminOptions) {
  return new SkillAdmin(options)
}

function applyOverride(summary: SkillMarket.Summary, override: SkillOverrideRow | undefined) {
  const hidden = override?.hidden ?? false
  const featured = override?.featured ?? summary.featured
  const categories = override?.category_override ? [override.category_override] : summary.categories
  return {
    ...summary,
    featured,
    delisted: hidden || summary.delisted,
    categories,
    hidden,
    hiddenReason: override?.hidden_reason ?? undefined,
  }
}

function toSkillAdminItem(summary: ReturnType<typeof applyOverride>, overrides: Map<string, SkillOverrideRow>) {
  const override = overrides.get(key(summary.source, summary.id))
  return {
    skill: {
      ...summary,
      delisted: summary.delisted,
      featured: summary.featured,
      categories: summary.categories,
    },
    override: override
      ? {
          featured: override.featured ?? false,
          hidden: override.hidden,
          hiddenReason: override.hidden_reason ?? undefined,
          category: override.category_override ?? undefined,
          updatedBy: override.updated_by,
          updatedAt: new Date(override.updated_at).toISOString(),
        }
      : undefined,
  }
}

async function loadOverrides(connection: Connection) {
  const rows = await connection.all<SkillOverrideRow>("SELECT * FROM skill_overrides")
  return new Map(rows.map((row) => [key(row.source as SkillMarket.Source, row.skill_id), row] as const))
}

async function loadHiddenCategories(connection: Connection) {
  return connection.all<HiddenCategoryRow>("SELECT * FROM hidden_categories")
}
