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
    const { overrides, hiddenCategories } = await this.options.database.read(async (connection) => ({
      overrides: await loadOverrides(connection),
      hiddenCategories: await loadHiddenCategories(connection),
    }))
    const keyword = decoded.value.query?.trim().toLocaleLowerCase()
    const hiddenCategorySet = new Set(hiddenCategories.map((row) => row.category))
    const items = index.items
      .map((summary) => {
        const override = overrides.get(key(summary.source, summary.id))
        const hidden = override?.hidden ?? false
        const featured = override?.featured ?? summary.featured
        const categories = override?.category_override ? [override.category_override] : summary.categories
        return {
          summary: { ...summary, featured, categories, delisted: hidden || summary.delisted },
          override,
        }
      })
      .filter((entry) => !hiddenCategorySet.has(entry.summary.categories[0] ?? ""))
      .filter((entry) => !decoded.value.source || entry.summary.source === decoded.value.source)
      .filter((entry) => !decoded.value.category || entry.summary.categories.includes(decoded.value.category!))
      .filter((entry) => decoded.value.featured === undefined || entry.summary.featured === decoded.value.featured)
      .filter((entry) => decoded.value.hidden === undefined || (entry.override?.hidden ?? false) === decoded.value.hidden)
      .filter(
        (entry) =>
          !keyword ||
          `${entry.summary.name}\n${entry.summary.description}\n${entry.summary.categories.join(" ")}\n${entry.summary.tags.join(" ")}\n${entry.summary.aliases?.join(" ") ?? ""}`
            .toLocaleLowerCase()
            .includes(keyword),
      )
      .toSorted((left, right) => {
        const nameCompare = left.summary.name.localeCompare(right.summary.name)
        return nameCompare !== 0
          ? nameCompare
          : key(left.summary.source, left.summary.id).localeCompare(key(right.summary.source, right.summary.id))
      })
    const page = decoded.value.page ?? 1
    const limit = decoded.value.limit ?? 30
    const start = (page - 1) * limit
    const pageItems = items.slice(start, start + limit).map((entry) => toSkillAdminItem(entry.summary, entry.override))
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

  async delete(principal: Principal, source: SkillMarket.Source, skillID: string, input: SkillMarketControl.ReasonInput) {
    this.options.security.requireAdmin(principal)
    if (!Schema.is(SkillMarket.Source)(source) || !Schema.is(SkillMarketControl.SubmissionSummary.fields.skillID)(skillID))
      throw new SkillMarketSecurityError("invalid-request", "skill admin delete target is invalid")
    const decoded = Schema.decodeUnknownOption(SkillMarketControl.ReasonInput)(input)
    if (Option.isNone(decoded)) throw new SkillMarketSecurityError("invalid-request", "skill admin delete payload is invalid")
    const now = this.options.now?.() ?? Date.now()
    if (source === "community") {
      await this.deleteCommunity(principal, skillID, decoded.value, now)
      return
    }
    await this.deleteExternal(principal, source, skillID, decoded.value, now)
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

  private async deleteCommunity(
    principal: Principal,
    skillID: string,
    input: SkillMarketControl.ReasonInput,
    now: number,
  ) {
    await this.options.database.transaction(async (connection) => {
      const skill = await connection.get<{ public_status: string | null }>(
        "SELECT public_status FROM community_skills WHERE skill_id = ?",
        [skillID],
      )
      if (!skill) throw new SkillMarketSecurityError("not-found", "community skill was not found")
      await connection.run("DELETE FROM community_skills WHERE skill_id = ?", [skillID])
      await connection.run("DELETE FROM submissions WHERE skill_id = ? AND target_scope = 'company'", [skillID])
      await enqueueCatalogRebuild(connection, now)
      await insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "skill-hidden",
        objectType: "community_skill",
        objectID: skillID,
        before: { status: skill.public_status },
        after: { deleted: true, reason: input.reason },
        now,
      })
    })
  }

  private async deleteExternal(
    principal: Principal,
    source: Exclude<SkillMarket.Source, "community">,
    skillID: string,
    input: SkillMarketControl.ReasonInput,
    now: number,
  ) {
    await this.options.database.transaction(async (connection) => {
      await connection.run(
        `INSERT INTO skill_overrides (skill_id, source, featured, hidden, hidden_reason, category_override, updated_by, updated_at)
         VALUES (?, ?, NULL, true, ?, NULL, ?, ?)
         ON CONFLICT(source, skill_id) DO UPDATE SET hidden = true, hidden_reason = excluded.hidden_reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [skillID, source, input.reason, principal.session.user.employeeID, now],
      )
      await enqueueCatalogRebuild(connection, now)
      await insertAudit(connection, {
        actorEmployeeID: principal.session.user.employeeID,
        action: "skill-hidden",
        objectType: "community_skill",
        objectID: `${source}:${skillID}`,
        after: { hidden: true, deleted: true, reason: input.reason },
        now,
      })
    })
  }

  private async getItem(principal: Principal, source: SkillMarket.Source, skillID: string) {
    this.options.security.requireAdmin(principal)
    const index = await this.options.catalog.index()
    const { overrides } = await this.options.database.read(async (connection) => ({
      overrides: await loadOverrides(connection),
    }))
    const summary = index.items.find((item) => item.source === source && item.id === skillID)
    if (!summary) throw new SkillMarketSecurityError("not-found", "skill was not found after update")
    const override = overrides.get(key(source, skillID))
    const hidden = override?.hidden ?? false
    const featured = override?.featured ?? summary.featured
    const categories = override?.category_override ? [override.category_override] : summary.categories
    return toSkillAdminItem({ ...summary, featured, categories, delisted: hidden || summary.delisted }, override)
  }
}

export function createSkillAdmin(options: SkillAdminOptions) {
  return new SkillAdmin(options)
}

function toSkillAdminItem(summary: SkillMarket.Summary, override: SkillOverrideRow | undefined): SkillMarketControl.SkillAdminItem {
  const base: Record<string, unknown> = { skill: summary }
  if (!override) return Schema.decodeUnknownSync(SkillMarketControl.SkillAdminItem)(base)
  const overrideValue: Record<string, unknown> = {
    featured: override.featured ?? false,
    hidden: override.hidden,
    updatedBy: override.updated_by,
    updatedAt: new Date(override.updated_at).toISOString(),
  }
  if (override.hidden_reason !== null) overrideValue.hiddenReason = override.hidden_reason
  if (override.category_override !== null) overrideValue.category = override.category_override
  base.override = overrideValue
  return Schema.decodeUnknownSync(SkillMarketControl.SkillAdminItem)(base)
}

async function loadOverrides(connection: Connection) {
  const rows = await connection.all<SkillOverrideRow>("SELECT * FROM skill_overrides")
  return new Map(rows.map((row) => [key(row.source as SkillMarket.Source, row.skill_id), row] as const))
}

async function loadHiddenCategories(connection: Connection) {
  return connection.all<HiddenCategoryRow>("SELECT * FROM hidden_categories")
}
