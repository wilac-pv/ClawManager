import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Option, Schema } from "effect"
import matter from "gray-matter"
import type { MarketDatabase } from "./store"

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const UpstreamPackage = Schema.Struct({
  slug: SkillMarket.ExpertPackageSummary.fields.slug,
  displayName: Schema.String,
  summary: Schema.String,
  scene: SkillMarket.ExpertPackageScene,
  subScene: Schema.String.pipe(Schema.optional),
  content: Schema.String,
  skillSlugs: Schema.Array(Schema.String),
  skillCount: Schema.Number,
  published: Schema.Number,
  updatedAt: Schema.Number,
})
const UpstreamPage = Schema.Struct({
  skillSets: Schema.Array(UpstreamPackage),
  total: Schema.Number,
})

interface PackageRow {
  readonly slug: string
  readonly display_name: string
  readonly summary: string
  readonly scene: SkillMarket.ExpertPackageScene
  readonly content: string
  readonly skill_slugs_json: string
  readonly skill_count: number
  readonly upstream_updated_at: number
}

export function createExpertPackages(options: {
  readonly database: MarketDatabase
  readonly baseUrl: string
  readonly fetcher?: Fetcher
  readonly now?: () => number
}) {
  return {
    async refresh() {
      const packages = await fetchAll(options.fetcher ?? fetch, options.baseUrl)
      const now = options.now?.() ?? Date.now()
      await options.database.transaction(async (connection) => {
        for (const entry of packages)
          await connection.run(
            `INSERT INTO expert_packages
              (slug, display_name, summary, scene, sub_scene, content, skill_slugs_json, skill_count,
               upstream_updated_at, synchronized_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(slug) DO UPDATE SET
               display_name = excluded.display_name,
               summary = excluded.summary,
               scene = excluded.scene,
               sub_scene = excluded.sub_scene,
               content = excluded.content,
               skill_slugs_json = excluded.skill_slugs_json,
               skill_count = excluded.skill_count,
               upstream_updated_at = excluded.upstream_updated_at,
               synchronized_at = excluded.synchronized_at`,
            [
              entry.slug,
              entry.displayName,
              entry.summary,
              entry.scene,
              entry.subScene ?? null,
              entry.content,
              JSON.stringify(entry.skillSlugs),
              entry.skillCount,
              entry.updatedAt,
              now,
            ],
          )
        if (packages.length === 0) return
        const placeholders = packages.map(() => "?").join(", ")
        await connection.run(
          `DELETE FROM expert_packages WHERE slug NOT IN (${placeholders})`,
          packages.map((entry) => entry.slug),
        )
      })
      return packages.length
    },

    list(query: {
      readonly query?: string
      readonly scene?: SkillMarket.ExpertPackageScene
      readonly page: number
      readonly limit: number
    }) {
      const filters: string[] = []
      const parameters: Array<string | number> = []
      if (query.query?.trim()) {
        filters.push("(display_name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')")
        const keyword = `%${escapeLike(query.query.trim())}%`
        parameters.push(keyword, keyword)
      }
      if (query.scene) {
        filters.push("scene = ?")
        parameters.push(query.scene)
      }
      const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : ""
      return options.database.read(async (connection) => {
        const total = (
          await connection.get<{ count: number }>(`SELECT count(*) AS count FROM expert_packages${where}`, parameters)
        )?.count
        const rows = await connection.all<PackageRow>(
          `SELECT slug, display_name, summary, scene, content, skill_slugs_json, skill_count, upstream_updated_at
             FROM expert_packages${where}
             ORDER BY upstream_updated_at DESC, slug LIMIT ? OFFSET ?`,
          [...parameters, query.limit, (query.page - 1) * query.limit],
        )
        const scenes = await connection.all<{ scene: SkillMarket.ExpertPackageScene; count: number }>(
          "SELECT scene, count(*) AS count FROM expert_packages GROUP BY scene ORDER BY scene",
        )
        return Schema.decodeUnknownSync(SkillMarket.ExpertPackagePage)({
          total,
          page: query.page,
          limit: query.limit,
          items: rows.map(summary),
          scenes: scenes.map((entry) => ({ value: entry.scene, count: entry.count })),
        })
      })
    },

    detail(slug: string) {
      return options.database
        .read(async (connection) =>
          connection.get<PackageRow>(
            `SELECT slug, display_name, summary, scene, content, skill_slugs_json, skill_count, upstream_updated_at
             FROM expert_packages WHERE slug = ?`,
            [slug],
          ),
        )
        .then((row) => {
          if (!row) return undefined
          return Schema.decodeUnknownSync(SkillMarket.ExpertPackageDetail)({
            ...summary(row),
            content: matter(row.content).content,
            skillSlugs: Schema.decodeUnknownSync(Schema.Array(Schema.String))(
              Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(row.skill_slugs_json),
            ),
          })
        })
    },
  }
}

export type ExpertPackages = ReturnType<typeof createExpertPackages>

async function fetchAll(fetcher: Fetcher, input: string) {
  const baseUrl = new URL(input)
  const packages: Array<typeof UpstreamPackage.Type> = []
  let received = 0
  for (let page = 1; ; page++) {
    const url = new URL("/api/v1/skillsets", baseUrl)
    url.searchParams.set("page", String(page))
    url.searchParams.set("pageSize", "200")
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`SkillHub expert package request failed with ${response.status}`)
    const decoded = Schema.decodeUnknownOption(UpstreamPage)(await response.json())
    if (Option.isNone(decoded)) throw new Error("SkillHub expert package response is malformed")
    received += decoded.value.skillSets.length
    packages.push(...decoded.value.skillSets.filter((entry) => entry.published === 1))
    if (received >= decoded.value.total || decoded.value.skillSets.length === 0) break
  }
  return Array.from(new Map(packages.map((entry) => [entry.slug, entry])).values())
}

function summary(row: PackageRow) {
  return {
    slug: row.slug,
    displayName: row.display_name,
    summary: row.summary,
    scene: row.scene,
    skillCount: row.skill_count,
    updatedAt: new Date(row.upstream_updated_at).toISOString(),
  }
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}
