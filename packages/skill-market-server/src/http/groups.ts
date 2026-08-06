import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import {
  SkillMarketControlNotFound,
  SkillMarketDependencyUnavailable,
  SkillMarketForbidden,
  SkillMarketInvalidRequest,
  SkillMarketSubmissionConflict,
} from "@opencode-ai/protocol/skill-market-errors"
import { SkillMarketPrincipal } from "@opencode-ai/protocol/skill-market-middleware"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { Groups } from "../groups"
import { SkillMarketSecurityError } from "../security"
import { principalFromSession, requestID } from "./middleware"

export function createGroupsHttp(groups: Groups) {
  return HttpApiBuilder.group(SkillMarketApi, "skillMarket.groups", (handlers) =>
    handlers
      .handle("skillMarket.groups.list", () =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({ try: () => groups.listMine(principal), catch: groupProblem })
        }),
      )
      .handle("skillMarket.groups.create", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({ try: () => groups.create(principal, context.payload), catch: groupProblem })
        }),
      )
      .handle("skillMarket.groups.detail", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => groups.get(principal, context.params.groupID),
            catch: groupProblem,
          })
        }),
      )
      .handle("skillMarket.groups.update", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => groups.update(principal, context.params.groupID, context.payload),
            catch: groupProblem,
          })
        }),
      )
      .handle("skillMarket.groups.transfer", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => groups.transfer(principal, context.params.groupID, context.payload),
            catch: groupProblem,
          })
        }),
      )
      .handle("skillMarket.groups.setStatus", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => groups.setStatus(principal, context.params.groupID, context.payload),
            catch: groupProblem,
          })
        }),
      )
      .handle("skillMarket.groups.members", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => groups.members(principal, context.params.groupID),
            catch: groupProblem,
          })
        }),
      )
      .handle("skillMarket.groups.addMember", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => groups.addMember(principal, context.params.groupID, context.payload),
            catch: groupProblem,
          })
        }),
      )
      .handle("skillMarket.groups.removeMember", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () =>
              groups.removeMember(principal, context.params.groupID, context.params.employeeID, context.payload),
            catch: groupProblem,
          })
        }),
      ),
  )
}

function groupProblem(error: unknown) {
  if (!(error instanceof SkillMarketSecurityError))
    return new SkillMarketDependencyUnavailable({
      code: "dependency-unavailable",
      message: "小组服务暂不可用",
      requestId: requestID(),
    })
  if (error.code === "invalid-request")
    return new SkillMarketInvalidRequest({ code: error.code, message: "小组请求无效", requestId: requestID() })
  if (error.code === "not-found")
    return new SkillMarketControlNotFound({ code: error.code, message: "小组不存在", requestId: requestID() })
  if (error.code === "submission-conflict")
    return new SkillMarketSubmissionConflict({
      code: error.code,
      message: "小组状态已发生变化，请刷新后重试",
      requestId: requestID(),
    })
  if (error.code === "forbidden")
    return new SkillMarketForbidden({ code: error.code, message: "没有管理此小组的权限", requestId: requestID() })
  return new SkillMarketDependencyUnavailable({
    code: "dependency-unavailable",
    message: "小组服务暂不可用",
    requestId: requestID(),
  })
}
