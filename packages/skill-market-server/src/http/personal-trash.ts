import { SkillMarketPersonalTrashGroup } from "@opencode-ai/protocol/groups/skill-market-submissions"
import {
  SkillMarketControlNotFound,
  SkillMarketDependencyUnavailable,
  SkillMarketSubmissionConflict,
} from "@opencode-ai/protocol/skill-market-errors"
import { SkillMarketPrincipal } from "@opencode-ai/protocol/skill-market-middleware"
import { Effect } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import type { PersonalTrash } from "../personal-trash"
import { SkillMarketSecurityError } from "../security"
import { principalFromSession, requestID } from "./middleware"

interface PersonalTrashHttpOptions {
  readonly personalTrash: PersonalTrash
}

const PersonalTrashApi = HttpApi.make("skillMarketPersonalTrash").add(SkillMarketPersonalTrashGroup)

export function createPersonalTrashHttp(options: PersonalTrashHttpOptions) {
  return HttpApiBuilder.group(PersonalTrashApi, "skillMarket.personalTrash", (handlers) =>
    handlers
      .handle("skillMarket.submissions.personalTrash", () =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.personalTrash.list(principal),
            catch: dependencyProblem,
          })
        }),
      )
      .handle("skillMarket.submissions.personalDelete", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () =>
              options.personalTrash.deletePersonal(
                principal,
                context.params.submissionID,
                context.payload.expectedVersion,
              ),
            catch: writeProblem,
          })
        }),
      )
      .handle("skillMarket.submissions.personalRestore", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () =>
              options.personalTrash.restorePersonal(
                principal,
                context.params.submissionID,
                context.payload.expectedVersion,
              ),
            catch: writeProblem,
          })
        }),
      ),
  )
}

function dependencyProblem() {
  return new SkillMarketDependencyUnavailable({
    code: "dependency-unavailable",
    message: "个人空间暂不可用",
    requestId: requestID(),
  })
}

function writeProblem(error: unknown) {
  if (error instanceof SkillMarketSecurityError && error.code === "not-found")
    return new SkillMarketControlNotFound({ code: "not-found", message: "个人 Skill 不存在", requestId: requestID() })
  if (error instanceof SkillMarketSecurityError && error.code === "submission-conflict")
    return new SkillMarketSubmissionConflict({
      code: "submission-conflict",
      message: "个人 Skill 状态已变化，请刷新后重试",
      requestId: requestID(),
    })
  return dependencyProblem()
}
