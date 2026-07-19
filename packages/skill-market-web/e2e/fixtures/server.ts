import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { communityDetail, communitySummary, detail, facets, summary, version } from "./catalog"

const webOrigin = "http://127.0.0.1:4211"
const csrfToken = "c".repeat(43)
const now = "2026-07-15T08:00:00.000Z"
const later = "2026-07-15T09:00:00.000Z"
const sha256 = "a".repeat(64)

const users = {
  submitter: { employeeID: "submitter1", displayName: "Submitter One", email: "submitter1@example.com" },
  reviewer: { employeeID: "reviewer1", displayName: "Reviewer One", email: "reviewer1@example.com" },
  admin: { employeeID: "admin1", displayName: "Admin One", email: "admin1@example.com" },
  other: { employeeID: "other1", displayName: "Other Submitter", email: "other1@example.com" },
  reviewer2: { employeeID: "reviewer2", displayName: "Reviewer Two", email: "reviewer2@example.com" },
} satisfies Record<string, SkillMarketControl.User>

type Persona = "anonymous" | "submitter" | "reviewer" | "admin"
type FixtureState = {
  submissions: Map<string, SkillMarketControl.SubmissionDetail>
  roles: SkillMarketControl.RoleAssignment[]
  audits: SkillMarketControl.AuditEvent[]
  idempotency: Map<string, SkillMarketControl.AcceptedSubmission>
  nextSubmission: number
}

const states = new Map<string, FixtureState>()
const publishedCommunity = makeSubmission({
  id: "sub_published01",
  skillID: "published-community-skill",
  owner: users.submitter,
  metadata: metadata("Published Community Skill", "1.0.0"),
  status: "published",
  currentPublicVersion: "1.0.0",
  publicSkill: {
    source: "community",
    id: "published-community-skill",
    version: "1.0.0",
    rowVersion: 1,
    status: "published",
  },
})

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4210,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) })
    if (url.pathname === "/health") return json(request, { ok: true })
    if (url.pathname === "/__fixture/reset" && request.method === "POST") return reset(request, url)
    if (url.pathname === "/__fixture/expire" && request.method === "POST") return expire(request)
    if (url.pathname.startsWith("/__fixture/bump/") && request.method === "POST") return bump(request, url)
    if (url.pathname === "/v1/auth/login" && request.method === "GET") return login(request, url)
    if (url.pathname === "/v1/auth/session" && request.method === "GET") return session(request)
    if (url.pathname === "/v1/auth/session" && request.method === "DELETE") return logout(request)

    const context = fixtureContext(request)
    if (url.pathname === "/v1/catalog/facets" && request.method === "GET") return json(request, catalogFacets(context))
    if (url.pathname === "/v1/catalog/skills" && request.method === "GET") return catalogPage(request, url, context)
    if (url.pathname.startsWith("/v1/catalog/skills/") && request.method === "GET") {
      return catalogRecord(request, url, context)
    }

    if (!context.user || !context.state) return problem(request, 401, "unauthenticated", "请先登录")
    if (request.method !== "GET" && !validCsrf(request)) {
      return problem(request, 403, "csrf-invalid", "CSRF 校验失败")
    }
    if (url.pathname === "/v1/submissions" && request.method === "GET") {
      return submissionList(request, url, context.state, context.user, false)
    }
    if (url.pathname === "/v1/submissions" && request.method === "POST") {
      return createSubmission(request, context.state, context.user)
    }
    if (url.pathname.startsWith("/v1/submissions/")) {
      return ownSubmission(request, url, context.state, context.user)
    }
    if (url.pathname === "/v1/admin/submissions" && request.method === "GET") {
      if (!reviewer(context.persona)) return problem(request, 403, "forbidden", "没有 Reviewer 权限")
      return submissionList(request, url, context.state, context.user, true)
    }
    if (url.pathname.startsWith("/v1/admin/submissions/")) {
      if (!reviewer(context.persona)) return problem(request, 403, "forbidden", "没有 Reviewer 权限")
      return moderation(request, url, context.state, context.user)
    }
    if (url.pathname.startsWith("/v1/admin/community-skills/")) {
      if (context.persona !== "admin") return problem(request, 403, "forbidden", "没有 Admin 权限")
      return moderateCommunity(request, url, context.state, context.user)
    }
    if (url.pathname === "/v1/admin/roles" && request.method === "GET") {
      if (context.persona !== "admin") return problem(request, 403, "forbidden", "没有 Admin 权限")
      return json(request, context.state.roles)
    }
    if (url.pathname === "/v1/admin/roles" && request.method === "POST") {
      if (context.persona !== "admin") return problem(request, 403, "forbidden", "没有 Admin 权限")
      return assignRole(request, context.state, context.user)
    }
    if (url.pathname.startsWith("/v1/admin/roles/") && request.method === "DELETE") {
      if (context.persona !== "admin") return problem(request, 403, "forbidden", "没有 Admin 权限")
      return removeRole(request, url, context.state, context.user)
    }
    if (url.pathname === "/v1/admin/audit" && request.method === "GET") {
      if (context.persona !== "admin") return problem(request, 403, "forbidden", "没有 Admin 权限")
      return auditPage(request, url, context.state)
    }
    return problem(request, 404, "not-found", "接口不存在")
  },
})

console.info(`Skill market fixture listening on ${server.url}`)

function reset(request: Request, url: URL) {
  const persona = parsePersona(url.searchParams.get("persona"))
  const tenant = crypto.randomUUID().replaceAll("-", "")
  states.set(tenant, initialState())
  return json(request, { ok: true, tenant, persona }, 200, cookieHeaders(tenant, persona))
}

function expire(request: Request) {
  const context = fixtureContext(request)
  if (!context.tenant) return problem(request, 404, "not-found", "测试会话不存在")
  return json(request, { ok: true }, 200, cookieHeaders(context.tenant, "anonymous"))
}

function bump(request: Request, url: URL) {
  const context = fixtureContext(request)
  const id = decodeURIComponent(url.pathname.slice("/__fixture/bump/".length))
  const current = context.state?.submissions.get(id)
  if (!context.state || !current) return problem(request, 404, "not-found", "投稿不存在")
  context.state.submissions.set(id, { ...current, version: current.version + 1, updatedAt: later })
  return json(request, { ok: true })
}

function login(request: Request, url: URL) {
  const context = fixtureContext(request)
  const tenant = context.tenant ?? crypto.randomUUID().replaceAll("-", "")
  if (!states.has(tenant)) states.set(tenant, initialState())
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"))
  const headers = cookieHeaders(tenant, "submitter")
  headers.set("location", `${webOrigin}${returnTo}`)
  return new Response(null, { status: 302, headers })
}

function session(request: Request) {
  const context = fixtureContext(request)
  if (!context.user) return json(request, null)
  const roles =
    context.persona === "admin"
      ? (["reviewer", "admin"] as const)
      : context.persona === "reviewer"
        ? (["reviewer"] as const)
        : []
  return json(request, {
    user: context.user,
    roles,
    csrfToken,
    createdAt: now,
    absoluteExpiresAt: "2026-07-16T08:00:00.000Z",
    idleExpiresAt: "2026-07-15T10:00:00.000Z",
  } satisfies SkillMarketControl.Session)
}

function logout(request: Request) {
  const context = fixtureContext(request)
  if (!validCsrf(request)) return problem(request, 403, "csrf-invalid", "CSRF 校验失败")
  const headers = corsHeaders(request)
  if (context.tenant) appendCookies(headers, context.tenant, "anonymous")
  return new Response(null, { status: 204, headers })
}

function catalogFacets(context: ReturnType<typeof fixtureContext>): SkillMarket.Facets {
  const items = catalogItems(context.state)
  return {
    ...facets,
    sources: [
      { value: "skillhub", count: items.filter((item) => item.source === "skillhub").length },
      { value: "enterprise", count: 0 },
      { value: "community", count: items.filter((item) => item.source === "community").length },
    ],
  }
}

function catalogPage(request: Request, url: URL, context: ReturnType<typeof fixtureContext>) {
  const query = url.searchParams.get("query")?.toLowerCase()
  const source = url.searchParams.get("source")
  const sourceStatus =
    query === "partial"
      ? { skillhub: "stale" as const, enterprise: "unavailable" as const, community: "fresh" as const }
      : facets.sourceStatus
  const items = catalogItems(context.state).filter((item) => {
    if (query === "empty") return false
    if (source && item.source !== source) return false
    if (!query || query === "partial") return true
    return `${item.name} ${item.description} ${item.tags.join(" ")}`.toLowerCase().includes(query)
  })
  return json(request, {
    revision: "fixture-revision",
    sourceStatus,
    total: items.length,
    page: Number(url.searchParams.get("page") ?? 1),
    limit: Number(url.searchParams.get("limit") ?? 30),
    items,
  } satisfies SkillMarket.Page)
}

function catalogRecord(request: Request, url: URL, context: ReturnType<typeof fixtureContext>) {
  const suffix = url.pathname.slice("/v1/catalog/skills/".length)
  const download = suffix.endsWith("/download")
  const versions = suffix.endsWith("/versions")
  const key = suffix.replace(/\/(?:download|versions)$/, "")
  if (key === "skillhub/code-review") {
    if (download)
      return json(request, { url: detail.package.url, sha256: detail.package.sha256, size: detail.package.size })
    if (versions) return json(request, [version])
    return json(request, detail)
  }
  if (key === "community/safe-community-skill") {
    if (download)
      return json(request, {
        url: communityDetail.package.url,
        sha256: communityDetail.package.sha256,
        size: communityDetail.package.size,
      })
    if (versions) return json(request, [version])
    return json(request, communityDetail)
  }
  const skillID = decodeURIComponent(key.replace(/^community\//, ""))
  if (skillID === publishedCommunity.skillID) {
    const record = publicDetail(publishedCommunity)
    if (download)
      return json(request, { url: record.package.url, sha256: record.package.sha256, size: record.package.size })
    if (versions) return json(request, record.versions)
    return json(request, record)
  }
  const published = [...(context.state?.submissions.values() ?? [])].find(
    (item) => item.publicSkill?.id === skillID && item.publicSkill.status === "published",
  )
  if (!published) return problem(request, 404, "not-found", "Skill 不存在")
  const record = publicDetail(published)
  if (download)
    return json(request, { url: record.package.url, sha256: record.package.sha256, size: record.package.size })
  if (versions) return json(request, record.versions)
  return json(request, record)
}

function submissionList(
  request: Request,
  url: URL,
  state: FixtureState,
  user: SkillMarketControl.User,
  admin: boolean,
) {
  const status = url.searchParams.get("status")
  const risk = url.searchParams.get("risk")
  const submitter = url.searchParams.get("submitter")
  const page = Number(url.searchParams.get("page") ?? 1)
  const limit = Number(url.searchParams.get("limit") ?? 30)
  const items = [...state.submissions.values()]
    .filter((item) => admin || item.owner.employeeID === user.employeeID)
    .filter((item) => !status || item.status === status)
    .filter((item) => !risk || item.risk === risk)
    .filter((item) => !submitter || item.owner.employeeID === submitter)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  return json(request, {
    total: items.length,
    page,
    limit,
    items: items.slice((page - 1) * limit, page * limit).map(submissionSummary),
  } satisfies SkillMarketControl.SubmissionPage)
}

async function createSubmission(request: Request, state: FixtureState, user: SkillMarketControl.User) {
  const cacheKey = idempotencyCacheKey(request)
  if (!cacheKey) return problem(request, 400, "invalid-request", "Idempotency-Key 无效")
  const cached = state.idempotency.get(cacheKey)
  if (cached) return json(request, cached)
  const input = await uploadInput(request)
  if (input instanceof Response) return input
  const id = `sub_created${String(state.nextSubmission++).padStart(3, "0")}`
  const skillID = slug(input.metadata.displayName)
  const invalid = input.package.name.toLowerCase().includes("invalid") || /invalid/i.test(input.metadata.displayName)
  const created = makeSubmission({
    id,
    skillID,
    owner: user,
    metadata: input.metadata,
    status: invalid ? "validation_failed" : "pending_review",
    risk: "safe",
    validationIssues: invalid
      ? [{ code: "SKILL_MD_MISSING", message: "ZIP 根目录缺少 SKILL.md", path: "SKILL.md" }]
      : [],
  })
  state.submissions.set(id, created)
  addAudit(state, user, "submission-created", "submission", id, { status: created.status })
  const accepted = { submission: submissionSummary(created) } satisfies SkillMarketControl.AcceptedSubmission
  state.idempotency.set(cacheKey, accepted)
  return json(request, accepted)
}

async function ownSubmission(request: Request, url: URL, state: FixtureState, user: SkillMarketControl.User) {
  const suffix = url.pathname.slice("/v1/submissions/".length)
  const revision = suffix.endsWith("/revisions")
  const id = decodeURIComponent(suffix.replace(/\/revisions$/, ""))
  const current = state.submissions.get(id)
  if (!current) return problem(request, 404, "not-found", "投稿不存在")
  if (current.owner.employeeID !== user.employeeID) return problem(request, 403, "forbidden", "只能读取自己的投稿")
  if (request.method === "GET" && !revision) return json(request, current)
  if (request.method !== "POST" || !revision) return problem(request, 404, "not-found", "接口不存在")
  const cacheKey = idempotencyCacheKey(request)
  if (!cacheKey) return problem(request, 400, "invalid-request", "Idempotency-Key 无效")
  const cached = state.idempotency.get(cacheKey)
  if (cached) return json(request, cached)
  const input = await revisionInput(request)
  if (input instanceof Response) return input
  if (input.expectedVersion !== current.version) return conflict(request)
  const nextRevision = current.currentRevision + 1
  const next = makeRevision(nextRevision, input.metadata, [])
  const updated: SkillMarketControl.SubmissionDetail = {
    ...current,
    targetVersion: input.metadata.version,
    status: "pending_review",
    currentRevision: nextRevision,
    version: current.version + 1,
    risk: "safe",
    updatedAt: later,
    metadata: input.metadata,
    revisions: [...current.revisions, next],
    timeline: [...current.timeline, { status: "pending_review", at: later, actor: user, message: "修订已提交审核" }],
  }
  state.submissions.set(id, updated)
  addAudit(state, user, "revision-uploaded", "revision", `${id}:${nextRevision}`, { status: "pending_review" })
  const accepted = { submission: submissionSummary(updated) } satisfies SkillMarketControl.AcceptedSubmission
  state.idempotency.set(cacheKey, accepted)
  return json(request, accepted)
}

async function moderation(request: Request, url: URL, state: FixtureState, actor: SkillMarketControl.User) {
  const suffix = url.pathname.slice("/v1/admin/submissions/".length)
  const operation = suffix.match(/\/(decision|retry-publish)$/)?.[1]
  const id = decodeURIComponent(suffix.replace(/\/(?:decision|retry-publish)$/, ""))
  const current = state.submissions.get(id)
  if (!current) return problem(request, 404, "not-found", "投稿不存在")
  if (request.method === "GET" && !operation) return json(request, current)
  if (request.method !== "POST" || !operation) return problem(request, 404, "not-found", "接口不存在")
  const input = await request.json().catch(() => undefined)
  if (!input || typeof input !== "object" || !("expectedVersion" in input)) {
    return problem(request, 400, "invalid-request", "请求格式无效")
  }
  if (input.expectedVersion !== current.version) return conflict(request)
  if (operation === "retry-publish") {
    if (current.status !== "publish_failed") return conflict(request)
    const publicSkill = {
      source: "community",
      id: current.skillID,
      version: current.targetVersion,
      rowVersion: (current.publicSkill?.rowVersion ?? 0) + 1,
      status: "published",
    } satisfies SkillMarketControl.PublicSkill
    const updated = {
      ...current,
      status: "published",
      version: current.version + 1,
      updatedAt: later,
      currentPublicVersion: current.targetVersion,
      publicSkill,
      timeline: [...current.timeline, { status: "published", at: later, actor, message: "重试发布成功" }],
    } satisfies SkillMarketControl.SubmissionDetail
    state.submissions.set(id, updated)
    addAudit(state, actor, "publish-retried", "publish_job", id, { status: "published" })
    return json(request, updated)
  }
  if (current.owner.employeeID === actor.employeeID) return problem(request, 403, "forbidden", "不能审核自己的投稿")
  if (current.status !== "pending_review") return conflict(request)
  const decision = "decision" in input ? input.decision : undefined
  if (decision !== "approve" && decision !== "request_changes" && decision !== "reject") {
    return problem(request, 400, "invalid-request", "审核决定无效")
  }
  const comment = typeof input.comment === "string" && input.comment ? input.comment : undefined
  const status =
    decision === "approve" ? "published" : decision === "request_changes" ? "changes_requested" : "rejected"
  const publicSkill =
    decision === "approve"
      ? ({
          source: "community",
          id: current.skillID,
          version: current.targetVersion,
          rowVersion: 1,
          status: "published",
        } satisfies SkillMarketControl.PublicSkill)
      : current.publicSkill
  const review = {
    revision: current.currentRevision,
    reviewer: actor,
    decision,
    ...(comment ? { comment } : {}),
    ...(typeof input.acceptedRiskSummary === "string" && input.acceptedRiskSummary
      ? { acceptedRiskSummary: input.acceptedRiskSummary }
      : {}),
    createdAt: later,
  } satisfies SkillMarketControl.Review
  const updated = {
    ...current,
    status,
    version: current.version + 1,
    updatedAt: later,
    ...(decision === "approve" ? { currentPublicVersion: current.targetVersion } : {}),
    ...(publicSkill ? { publicSkill } : {}),
    reviews: [...current.reviews, review],
    timeline: [...current.timeline, { status, at: later, actor, ...(comment ? { message: comment } : {}) }],
  } satisfies SkillMarketControl.SubmissionDetail
  state.submissions.set(id, updated)
  addAudit(
    state,
    actor,
    decision === "approve"
      ? "review-approved"
      : decision === "request_changes"
        ? "review-changes-requested"
        : "review-rejected",
    "submission",
    id,
    { status },
  )
  return json(request, updated)
}

async function moderateCommunity(request: Request, url: URL, state: FixtureState, actor: SkillMarketControl.User) {
  const suffix = url.pathname.slice("/v1/admin/community-skills/".length)
  const operation = suffix.match(/\/(delist|restore)$/)?.[1]
  const id = decodeURIComponent(suffix.replace(/\/(?:delist|restore)$/, ""))
  const current = [...state.submissions.values()].find((item) => item.publicSkill?.id === id)
  if (!current?.publicSkill || request.method !== "POST" || !operation) {
    return problem(request, 404, "not-found", "公开 Skill 不存在")
  }
  const input = await request.json().catch(() => undefined)
  if (!input || typeof input !== "object" || !("expectedVersion" in input)) {
    return problem(request, 400, "invalid-request", "请求格式无效")
  }
  if (input.expectedVersion !== current.publicSkill.rowVersion) return conflict(request)
  const publicSkill = {
    ...current.publicSkill,
    rowVersion: current.publicSkill.rowVersion + 1,
    status: operation === "delist" ? "delisted" : "published",
  } satisfies SkillMarketControl.PublicSkill
  state.submissions.set(current.id, { ...current, publicSkill })
  addAudit(state, actor, operation === "delist" ? "community-delisted" : "community-restored", "community_skill", id, {
    status: publicSkill.status,
  })
  return json(request, publicSkill)
}

async function assignRole(request: Request, state: FixtureState, actor: SkillMarketControl.User) {
  const input = await request.json().catch(() => undefined)
  if (
    !input ||
    typeof input !== "object" ||
    !("employeeID" in input) ||
    !("role" in input) ||
    typeof input.employeeID !== "string" ||
    (input.role !== "reviewer" && input.role !== "admin")
  ) {
    return problem(request, 400, "invalid-request", "角色请求无效")
  }
  if (state.roles.some((item) => item.user.employeeID === input.employeeID && item.role === input.role)) {
    return problem(request, 400, "invalid-request", "该角色已存在")
  }
  const user =
    input.employeeID === users.reviewer2.employeeID
      ? users.reviewer2
      : { employeeID: input.employeeID, displayName: input.employeeID }
  const assignment = {
    user,
    role: input.role,
    createdBy: actor.employeeID,
    createdAt: later,
  } satisfies SkillMarketControl.RoleAssignment
  state.roles.push(assignment)
  addAudit(state, actor, "role-assigned", "role", `${input.employeeID}:${input.role}`, { role: input.role })
  return json(request, assignment)
}

function removeRole(request: Request, url: URL, state: FixtureState, actor: SkillMarketControl.User) {
  const [employeeID, role] = url.pathname.slice("/v1/admin/roles/".length).split("/").map(decodeURIComponent)
  if ((role !== "reviewer" && role !== "admin") || !employeeID) {
    return problem(request, 400, "invalid-request", "角色请求无效")
  }
  if (role === "admin" && state.roles.filter((item) => item.role === "admin").length <= 1) {
    return problem(request, 409, "last-admin", "至少保留一名 Admin")
  }
  state.roles = state.roles.filter((item) => item.user.employeeID !== employeeID || item.role !== role)
  addAudit(state, actor, "role-removed", "role", `${employeeID}:${role}`, { role })
  return json(request, state.roles)
}

function auditPage(request: Request, url: URL, state: FixtureState) {
  const actor = url.searchParams.get("actor")
  const action = url.searchParams.get("action")
  const objectType = url.searchParams.get("objectType")
  const objectID = url.searchParams.get("objectID")
  const page = Number(url.searchParams.get("page") ?? 1)
  const limit = Number(url.searchParams.get("limit") ?? 30)
  const items = state.audits.filter((item) => {
    if (actor && item.actor?.employeeID !== actor) return false
    if (action && item.action !== action) return false
    if (objectType && item.objectType !== objectType) return false
    return !objectID || item.objectID === objectID
  })
  return json(request, { total: items.length, page, limit, items: items.slice((page - 1) * limit, page * limit) })
}

function initialState(): FixtureState {
  const submissions = [
    makeSubmission({
      id: "sub_validation01",
      skillID: "invalid-community-skill",
      owner: users.submitter,
      metadata: metadata("Invalid Community Skill", "1.0.0"),
      status: "validation_failed",
      validationIssues: [{ code: "SKILL_MD_MISSING", message: "ZIP 根目录缺少 SKILL.md", path: "SKILL.md" }],
    }),
    makeSubmission({
      id: "sub_changes001",
      skillID: "changes-community-skill",
      owner: users.submitter,
      metadata: metadata("Changes Community Skill", "1.0.0"),
      status: "changes_requested",
      reviews: [review(users.reviewer, "request_changes", "请补充使用说明")],
    }),
    makeSubmission({
      id: "sub_rejected001",
      skillID: "rejected-community-skill",
      owner: users.submitter,
      metadata: metadata("Rejected Community Skill", "1.0.0"),
      status: "rejected",
      reviews: [review(users.reviewer, "reject", "包用途不明确")],
    }),
    publishedCommunity,
    makeSubmission({
      id: "sub_reviewrisk1",
      skillID: "dangerous-community-skill",
      owner: users.other,
      metadata: metadata("Dangerous Community Skill", "1.0.0"),
      status: "pending_review",
      risk: "danger",
    }),
    makeSubmission({
      id: "sub_selfreview01",
      skillID: "reviewer-owned-skill",
      owner: users.reviewer,
      metadata: metadata("Reviewer Owned Skill", "1.0.0"),
      status: "pending_review",
    }),
    makeSubmission({
      id: "sub_conflict001",
      skillID: "conflict-community-skill",
      owner: users.other,
      metadata: metadata("Conflict Community Skill", "1.0.0"),
      status: "pending_review",
    }),
    makeSubmission({
      id: "sub_publishfail",
      skillID: "publish-failed-skill",
      owner: users.other,
      metadata: metadata("Publish Failed Skill", "1.0.0"),
      status: "publish_failed",
    }),
  ]
  return {
    submissions: new Map(submissions.map((item) => [item.id, item])),
    roles: [
      { user: users.admin, role: "admin", createdBy: "system", createdAt: now },
      { user: users.reviewer, role: "reviewer", createdBy: users.admin.employeeID, createdAt: now },
    ],
    audits: [
      {
        id: "aud_fixture0001",
        actor: users.admin,
        action: "bootstrap-admin",
        objectType: "role",
        objectID: "admin1:admin",
        after: { role: "admin" },
        requestID: "req_fixture001",
        createdAt: now,
      },
    ],
    idempotency: new Map(),
    nextSubmission: 1,
  }
}

function makeSubmission(input: {
  id: string
  skillID: string
  owner: SkillMarketControl.User
  metadata: SkillMarketControl.SubmissionMetadata
  status: SkillMarketControl.SubmissionStatus
  risk?: SkillMarket.Risk
  validationIssues?: SkillMarketControl.ValidationIssue[]
  reviews?: SkillMarketControl.Review[]
  currentPublicVersion?: string
  publicSkill?: SkillMarketControl.PublicSkill
}): SkillMarketControl.SubmissionDetail {
  const revision = makeRevision(1, input.metadata, input.validationIssues ?? [], input.risk ?? "safe")
  return {
    id: input.id,
    skillID: input.skillID,
    owner: input.owner,
    targetVersion: input.metadata.version,
    status: input.status,
    currentRevision: 1,
    version: 1,
    risk: input.risk ?? "safe",
    ...(input.currentPublicVersion ? { currentPublicVersion: input.currentPublicVersion } : {}),
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata,
    revisions: [revision],
    reviews: input.reviews ?? [],
    timeline: [{ status: input.status, at: now, actor: input.owner, message: statusMessage(input.status) }],
    ...(input.publicSkill ? { publicSkill: input.publicSkill } : {}),
  }
}

function makeRevision(
  number: number,
  value: SkillMarketControl.SubmissionMetadata,
  validationIssues: SkillMarketControl.ValidationIssue[],
  risk: SkillMarket.Risk = "safe",
): SkillMarketControl.Revision {
  return {
    number,
    metadata: value,
    manifest: {
      packageSha256: sha256,
      packageSize: 2048,
      files: [{ path: "SKILL.md", sha256, size: 1024, mime: "text/markdown" }],
    },
    scan: {
      risk,
      reasons: risk === "safe" ? [] : ["请求访问外部网络"],
      evidence:
        risk === "safe" ? [] : [{ rule: "NETWORK_ACCESS", summary: "检测到外部网络访问", path: "SKILL.md", line: 8 }],
      scannedAt: now,
    },
    validationIssues,
    createdAt: now,
  }
}

function metadata(displayName: string, targetVersion: string): SkillMarketControl.SubmissionMetadata {
  return {
    version: targetVersion,
    displayName,
    description: "用于浏览器端到端验证的社区 Skill",
    category: "代码质量",
    tags: ["review", "community"],
    license: "MIT",
    requiresApiKey: false,
    changeNotes: "首次投稿",
  }
}

function review(
  reviewer: SkillMarketControl.User,
  decision: SkillMarketControl.ReviewDecision,
  comment: string,
): SkillMarketControl.Review {
  return { revision: 1, reviewer, decision, comment, createdAt: now }
}

function catalogItems(state?: FixtureState): SkillMarket.Summary[] {
  const dynamic = [...(state?.submissions.values() ?? [])]
    .filter(
      (item) =>
        item.skillID !== publishedCommunity.skillID &&
        item.status === "published" &&
        item.publicSkill?.status === "published",
    )
    .map(publicSummary)
  return [summary, communitySummary, publicSummary(publishedCommunity), ...dynamic]
}

function publicSummary(record: SkillMarketControl.SubmissionDetail): SkillMarket.Summary {
  return {
    id: record.skillID,
    source: "community",
    sourceUrl: `https://market.example.com/skills/community/${record.skillID}`,
    name: record.metadata.displayName,
    description: record.metadata.description,
    categories: [record.metadata.category],
    tags: record.metadata.tags,
    requiresApiKey: record.metadata.requiresApiKey,
    risk: record.risk,
    version: record.publicSkill?.version ?? record.targetVersion,
    updatedAt: record.updatedAt,
    downloads: 0,
    favorites: 0,
    score: 80,
    featured: false,
    enterprise: false,
    delisted: false,
    submittedBy: { displayName: record.owner.displayName },
    reviewedAt: record.updatedAt,
    reviewRisk: record.risk,
  }
}

function publicDetail(record: SkillMarketControl.SubmissionDetail): SkillMarket.Detail {
  return {
    ...publicSummary(record),
    readme: `# ${record.metadata.displayName}\n\n${record.metadata.description}`,
    license: record.metadata.license,
    author: { name: record.owner.displayName },
    versions: [{ version: record.targetVersion, publishedAt: record.updatedAt, sha256, size: 2048 }],
    securityReports: [{ provider: "Ruying Scanner", verdict: record.risk, summary: "审核扫描已完成" }],
    package: {
      url: `https://downloads.example.com/${record.skillID}.zip`,
      sha256,
      size: 2048,
      files: [{ path: "SKILL.md", sha256, size: 1024 }],
    },
    publicDetailUrl: `https://market.example.com/skills/community/${record.skillID}`,
  }
}

function submissionSummary(record: SkillMarketControl.SubmissionDetail): SkillMarketControl.SubmissionSummary {
  return {
    id: record.id,
    skillID: record.skillID,
    owner: record.owner,
    targetVersion: record.targetVersion,
    status: record.status,
    currentRevision: record.currentRevision,
    version: record.version,
    risk: record.risk,
    ...(record.currentPublicVersion ? { currentPublicVersion: record.currentPublicVersion } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

async function uploadInput(request: Request) {
  const form = await request.formData().catch(() => undefined)
  const raw = form?.get("metadata")
  const file = form?.get("package")
  if (typeof raw !== "string" || !(file instanceof File))
    return problem(request, 400, "invalid-request", "上传格式无效")
  const metadata = parseJson(raw)
  if (!submissionMetadata(metadata)) return problem(request, 400, "invalid-request", "投稿信息无效")
  return { metadata, package: file }
}

async function revisionInput(request: Request) {
  const form = await request.formData().catch(() => undefined)
  const raw = form?.get("metadata")
  const file = form?.get("package")
  if (typeof raw !== "string" || !(file instanceof File))
    return problem(request, 400, "invalid-request", "上传格式无效")
  const value = parseJson(raw)
  if (!value || typeof value !== "object" || !("expectedVersion" in value) || !("metadata" in value)) {
    return problem(request, 400, "invalid-request", "修订信息无效")
  }
  if (typeof value.expectedVersion !== "number" || !submissionMetadata(value.metadata)) {
    return problem(request, 400, "invalid-request", "修订信息无效")
  }
  return { expectedVersion: value.expectedVersion, metadata: value.metadata }
}

function submissionMetadata(value: unknown): value is SkillMarketControl.SubmissionMetadata {
  if (!value || typeof value !== "object") return false
  return (
    "version" in value &&
    typeof value.version === "string" &&
    "displayName" in value &&
    typeof value.displayName === "string" &&
    "description" in value &&
    typeof value.description === "string" &&
    "category" in value &&
    typeof value.category === "string" &&
    "tags" in value &&
    Array.isArray(value.tags) &&
    "requiresApiKey" in value &&
    typeof value.requiresApiKey === "boolean" &&
    "changeNotes" in value &&
    typeof value.changeNotes === "string"
  )
}

function addAudit(
  state: FixtureState,
  actor: SkillMarketControl.User,
  action: SkillMarketControl.AuditAction,
  objectType: SkillMarketControl.AuditObjectType,
  objectID: string,
  after: Record<string, string>,
) {
  state.audits.unshift({
    id: `aud_fixture${String(state.audits.length + 1).padStart(4, "0")}`,
    actor,
    action,
    objectType,
    objectID,
    after,
    requestID: `req_fixture${String(state.audits.length + 1).padStart(3, "0")}`,
    createdAt: later,
  })
}

function fixtureContext(request: Request) {
  const cookies = parseCookies(request.headers.get("cookie"))
  const tenant = cookies.fixture_tenant
  const persona = parsePersona(cookies.fixture_persona)
  const user = persona === "anonymous" ? undefined : users[persona]
  return { tenant, persona, user, state: tenant ? states.get(tenant) : undefined }
}

function parseCookies(value: string | null) {
  return Object.fromEntries(
    (value ?? "")
      .split(";")
      .map((entry) => entry.trim().split("="))
      .filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0])),
  )
}

function parsePersona(value: string | null | undefined): Persona {
  if (value === "submitter" || value === "reviewer" || value === "admin") return value
  return "anonymous"
}

function reviewer(persona: Persona) {
  return persona === "reviewer" || persona === "admin"
}

function validCsrf(request: Request) {
  return request.headers.get("x-csrf-token") === csrfToken
}

function idempotencyCacheKey(request: Request) {
  const value = request.headers.get("idempotency-key")
  if (!value || !/^[\x21-\x7e]{8,200}$/.test(value)) return undefined
  return `${new URL(request.url).pathname}:${value}`
}

function cookieHeaders(tenant: string, persona: Persona) {
  const headers = new Headers()
  appendCookies(headers, tenant, persona)
  return headers
}

function appendCookies(headers: Headers, tenant: string, persona: Persona) {
  headers.append("set-cookie", `fixture_tenant=${tenant}; Path=/; SameSite=Lax`)
  headers.append("set-cookie", `fixture_persona=${persona}; Path=/; SameSite=Lax`)
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin")
  const headers = new Headers({
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type, idempotency-key, x-csrf-token",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "cache-control": "no-store",
    vary: "origin",
  })
  if (origin === webOrigin) headers.set("access-control-allow-origin", origin)
  return headers
}

function json(request: Request, value: unknown, status = 200, extra = new Headers()) {
  const headers = corsHeaders(request)
  extra.forEach((header, key) => headers.append(key, header))
  headers.set("content-type", "application/json")
  return Response.json(value, { status, headers })
}

function problem(request: Request, status: number, code: SkillMarketControl.ProblemCode, message: string) {
  return json(request, { code, message, requestId: "req_fixture999" } satisfies SkillMarketControl.Problem, status)
}

function conflict(request: Request) {
  return problem(request, 409, "submission-conflict", "对象版本已更新")
}

function safeReturnTo(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/skills"
  return value
}

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 128)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function statusMessage(status: SkillMarketControl.SubmissionStatus) {
  if (status === "validation_failed") return "自动校验未通过"
  if (status === "changes_requested") return "审核人要求修改"
  if (status === "rejected") return "审核已拒绝"
  if (status === "publish_failed") return "自动发布失败"
  if (status === "published") return "已发布到社区市场"
  return "等待人工审核"
}
