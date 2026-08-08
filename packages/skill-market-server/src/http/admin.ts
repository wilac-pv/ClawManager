import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import {
  SkillMarketControlNotFound,
  SkillMarketDependencyUnavailable,
  SkillMarketForbidden,
  SkillMarketInvalidRequest,
  SkillMarketLastAdmin,
  SkillMarketSubmissionConflict,
} from "@opencode-ai/protocol/skill-market-errors"
import { SkillMarketPrincipal } from "@opencode-ai/protocol/skill-market-middleware"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { Announcements } from "../announcements"
import type { MarketMetricEmitter } from "../metrics"
import type { Moderation } from "../moderation"
import type { SkillAdmin } from "../skill-admin"
import { SkillMarketSecurityError } from "../security"
import type { SkillHubImportAdmin } from "../skillhub-import-admin"
import { principalFromSession, requestID } from "./middleware"

interface AdminHttpOptions {
  readonly announcements: Announcements
  readonly moderation: Moderation
  readonly skillAdmin: SkillAdmin
  readonly skillhubImportAdmin: SkillHubImportAdmin
  readonly onWorkReady?: () => void
  readonly onSkillHubWorkReady?: () => void
  readonly emit?: MarketMetricEmitter
}

export function createAdminHttp(options: AdminHttpOptions) {
  const admin = HttpApiBuilder.group(SkillMarketApi, "skillMarket.admin", (handlers) =>
    handlers
      .handle("skillMarket.admin.submissions.list", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () =>
              options.moderation.listQueue(principal, {
                ...context.query,
                page: context.query.page ?? 1,
                limit: context.query.limit ?? 30,
              }),
            catch: dependencyProblem,
          })
        }),
      )
      .handle("skillMarket.admin.submissions.detail", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: async () => {
              const detail = await options.moderation.get(principal, context.params.submissionID)
              if (!detail) throw new Error("submission not found")
              return detail
            },
            catch: readProblem,
          })
        }),
      )
      .handle("skillMarket.admin.submissions.decision", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const reviewed = yield* Effect.tryPromise({
            try: async () => {
              const before = await options.moderation.get(principal, context.params.submissionID)
              const result = await options.moderation.decide(principal, context.params.submissionID, context.payload)
              if (!result) throw new Error("review decision produced no result")
              const pending = before?.timeline.findLast((event) => event.status === "pending_review")
              return {
                result,
                ...(pending ? { wait: Math.max(0, Date.parse(result.updatedAt) - Date.parse(pending.at)) } : {}),
              }
            },
            catch: reviewProblem,
          })
          options.emit?.({
            skill_market_review_decision: { [context.payload.decision]: 1 },
            ...(reviewed.wait === undefined ? {} : { skill_market_review_wait_ms: reviewed.wait }),
          })
          if (reviewed.result.status === "publishing") options.onWorkReady?.()
          return reviewed.result
        }),
      )
      .handle("skillMarket.admin.submissions.retry", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const result = yield* Effect.tryPromise({
            try: async () => {
              const detail = await options.moderation.retryPublish(principal, context.params.submissionID, context.payload)
              if (!detail) throw new Error("retry publish produced no result")
              return detail
            },
            catch: reviewProblem,
          })
          options.onWorkReady?.()
          return result
        }),
      )
      .handle("skillMarket.admin.roles.list", () =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({ try: () => options.moderation.listRoles(principal), catch: dependencyProblem })
        }),
      )
      .handle("skillMarket.admin.announcements.create", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.try({
            try: () => options.announcements.publish(principal, context.payload),
            catch: dependencyProblem,
          })
        }),
      )
      .handle("skillMarket.admin.roles.create", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.moderation.assignRole(principal, context.payload),
            catch: roleCreateProblem,
          })
        }),
      )
      .handle("skillMarket.admin.roles.delete", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.moderation.removeRole(principal, context.params.employeeID, context.params.role),
            catch: roleDeleteProblem,
          })
        }),
      )
      .handle("skillMarket.admin.audit.list", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () =>
              options.moderation.listAudit(principal, {
                ...context.query,
                page: context.query.page ?? 1,
                limit: context.query.limit ?? 30,
              }),
            catch: dependencyProblem,
          })
        }),
      )
      .handle("skillMarket.admin.community.delist", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const result = yield* Effect.tryPromise({
            try: () => options.moderation.delist(principal, context.params.skillID, context.payload),
            catch: reviewProblem,
          })
          options.onWorkReady?.()
          return result
        }),
      )
      .handle("skillMarket.admin.community.restore", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const result = yield* Effect.tryPromise({
            try: () => options.moderation.restore(principal, context.params.skillID, context.payload),
            catch: reviewProblem,
          })
          options.onWorkReady?.()
          return result
        }),
      )
      .handle("skillMarket.admin.skills.list", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => {
              const query: Record<string, unknown> = {
                page: context.query.page ?? 1,
                limit: context.query.limit ?? 30,
              }
              if (context.query.query !== undefined) query.query = context.query.query
              if (context.query.source !== undefined) query.source = context.query.source
              if (context.query.category !== undefined) query.category = context.query.category
              if (context.query.hidden !== undefined) query.hidden = context.query.hidden === "true"
              if (context.query.featured !== undefined) query.featured = context.query.featured === "true"
              return options.skillAdmin.list(principal, query as SkillMarketControl.SkillAdminListQuery)
            },
            catch: dependencyProblem,
          })
        }),
      )
      .handle("skillMarket.admin.skills.hiddenCategories", () =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.skillAdmin.hiddenCategories(principal),
            catch: dependencyProblem,
          })
        }),
      )
      .handle("skillMarket.admin.skills.delistByCategory", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const result = yield* Effect.tryPromise({
            try: () => options.skillAdmin.delistByCategory(principal, context.payload),
            catch: reviewProblem,
          })
          options.onWorkReady?.()
          return result
        }),
      )
      .handle("skillMarket.admin.skills.restoreByCategory", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const result = yield* Effect.tryPromise({
            try: () => options.skillAdmin.restoreByCategory(principal, context.payload),
            catch: reviewProblem,
          })
          options.onWorkReady?.()
          return result
        }),
      )
      .handle("skillMarket.admin.skills.update", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const result = yield* Effect.tryPromise({
            try: () => options.skillAdmin.update(principal, context.params.source, context.params.skillID, context.payload),
            catch: reviewProblem,
          })
          options.onWorkReady?.()
          return result
        }),
      )
      .handle("skillMarket.admin.skills.delist", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const result = yield* Effect.tryPromise({
            try: () => options.skillAdmin.delist(principal, context.params.source, context.params.skillID, context.payload),
            catch: reviewProblem,
          })
          options.onWorkReady?.()
          return result
        }),
      )
      .handle("skillMarket.admin.skills.restore", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const result = yield* Effect.tryPromise({
            try: () => options.skillAdmin.restore(principal, context.params.source, context.params.skillID, context.payload),
            catch: reviewProblem,
          })
          options.onWorkReady?.()
          return result
        }),
      )
      .handle("skillMarket.admin.skillhub.status", () =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.skillhubImportAdmin.status(principal),
            catch: dependencyProblem,
          })
        }),
      )
      .handle("skillMarket.admin.skillhub.command", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const result = yield* Effect.tryPromise({
            try: () => options.skillhubImportAdmin.command(principal, context.payload),
            catch: skillHubProblem,
          })
          if (context.payload.command !== "pause") options.onSkillHubWorkReady?.()
          return result
        }),
      )
      .handle("skillMarket.admin.skillhub.evaluation", () =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.skillhubImportAdmin.evaluation(principal),
            catch: dependencyProblem,
          })
        }),
      ),
  )
  const lifecycle = HttpApiBuilder.group(SkillMarketApi, "skillMarket.adminLifecycle", (handlers) =>
    handlers
      .handle("skillMarket.admin.pendingDelist", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.moderation.pendingDelist(principal, context.params.submissionID),
            catch: reviewProblem,
          })
        }),
      )
      .handle("skillMarket.admin.listDelist", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.moderation.listDelistQueue(principal, context.query),
            catch: reviewProblem,
          })
        }),
      )
      .handle("skillMarket.admin.approveDelist", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const result = yield* Effect.tryPromise({
            try: () =>
              options.moderation.decideDelist(principal, context.params.requestID, context.payload, "approved"),
            catch: reviewProblem,
          })
          options.onWorkReady?.()
          return result
        }),
      )
      .handle("skillMarket.admin.rejectDelist", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () =>
              options.moderation.decideDelist(principal, context.params.requestID, context.payload, "rejected"),
            catch: reviewProblem,
          })
        }),
      ),
  )
  return Layer.merge(admin, lifecycle)
}

function dependencyProblem(error?: unknown) {
  if (error instanceof SkillMarketSecurityError && error.code === "forbidden")
    return new SkillMarketForbidden({
      code: "forbidden",
      message: "没有执行此管理操作的权限",
      requestId: requestID(),
    })
  return new SkillMarketDependencyUnavailable({
    code: "dependency-unavailable",
    message: "管理服务暂不可用",
    requestId: requestID(),
  })
}

function readProblem(error: unknown) {
  if (error instanceof SkillMarketSecurityError && error.code === "not-found")
    return new SkillMarketControlNotFound({ code: "not-found", message: "投稿不存在", requestId: requestID() })
  return dependencyProblem(error)
}

function reviewProblem(error: unknown) {
  if (!(error instanceof SkillMarketSecurityError)) return dependencyProblem()
  if (error.code === "invalid-request")
    return new SkillMarketInvalidRequest({ code: error.code, message: "管理请求无效", requestId: requestID() })
  if (error.code === "not-found")
    return new SkillMarketControlNotFound({ code: error.code, message: "目标不存在", requestId: requestID() })
  if (error.code === "submission-conflict")
    return new SkillMarketSubmissionConflict({
      code: error.code,
      message: "目标状态已发生变化，请刷新后重试",
      requestId: requestID(),
    })
  return dependencyProblem(error)
}

function skillHubProblem(error: unknown) {
  if (error instanceof SkillMarketSecurityError && error.code === "invalid-request")
    return new SkillMarketInvalidRequest({
      code: "invalid-request",
      message: "SkillHub 导入请求无效",
      requestId: requestID(),
    })
  return dependencyProblem(error)
}

function roleCreateProblem(error: unknown) {
  if (error instanceof SkillMarketSecurityError && error.message === "role is already assigned")
    return new SkillMarketInvalidRequest({
      code: "invalid-request",
      message: "该用户已拥有此角色",
      requestId: requestID(),
    })
  if (error instanceof SkillMarketSecurityError && (error.code === "invalid-request" || error.code === "not-found"))
    return new SkillMarketInvalidRequest({
      code: "invalid-request",
      message: "角色分配请求无效",
      requestId: requestID(),
    })
  return dependencyProblem(error)
}

function roleDeleteProblem(error: unknown) {
  if (error instanceof SkillMarketSecurityError && error.code === "not-found")
    return new SkillMarketControlNotFound({ code: error.code, message: "角色分配不存在", requestId: requestID() })
  if (error instanceof SkillMarketSecurityError && error.code === "last-admin")
    return new SkillMarketLastAdmin({
      code: error.code,
      message: "不能删除最后一个管理员",
      requestId: requestID(),
    })
  return dependencyProblem(error)
}
