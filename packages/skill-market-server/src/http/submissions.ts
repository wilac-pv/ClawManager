import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import {
  SkillMarketControlNotFound,
  SkillMarketDependencyUnavailable,
  SkillMarketForbidden,
  SkillMarketInvalidRequest,
  SkillMarketOwnershipConflict,
  SkillMarketSubmissionConflict,
  SkillMarketUploadRateLimited,
  SkillMarketUploadTooLarge,
  SkillMarketValidationFailed,
} from "@opencode-ai/protocol/skill-market-errors"
import { SkillMarketPrincipal } from "@opencode-ai/protocol/skill-market-middleware"
import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse, Multipart } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { MarketMetricEmitter } from "../metrics"
import type { PrivateObjectStore } from "../oss"
import type { PersonalTrash } from "../personal-trash"
import { randomSecret, SkillMarketSecurityError } from "../security"
import {
  receiveSubmission,
  type ReceivedSubmission,
  type SubmissionPart,
  validateQuarantinedSubmission,
} from "../submission-archive"
import type { SubmissionIcon, Submissions } from "../submissions"
import { principalFromSession, requestID } from "./middleware"

interface SubmissionsHttpOptions {
  readonly submissions: Submissions
  readonly personalTrash: PersonalTrash
  readonly store: PrivateObjectStore
  readonly privatePrefix: string
  readonly emit?: MarketMetricEmitter
}

export function createSubmissionsHttp(options: SubmissionsHttpOptions) {
  const submissions = HttpApiBuilder.group(SkillMarketApi, "skillMarket.submissions", (handlers) =>
    handlers
      .handle("skillMarket.submissions.list", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () =>
              options.submissions.listOwn(principal, {
                status: context.query.status,
                target: context.query.target,
                page: context.query.page ?? 1,
                limit: context.query.limit ?? 30,
              }),
            catch: dependencyProblem,
          })
        }),
      )
      .handle("skillMarket.submissions.create", (context) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const idempotencyKey = yield* readIdempotencyKey(request.headers["idempotency-key"])
          const submissionID = `sub_${randomSecret()}`
          const state: {
            target?: SkillMarketControl.PublicationTarget
            audience?: SkillMarketControl.AudienceInput
          } = {}
          const received = yield* receive(
            context.payload,
            options,
            principal.session.user.employeeID,
            submissionID,
            1,
            "create",
            state,
          )
          const validated = yield* Effect.tryPromise({
            try: () => validateQuarantinedSubmission(received, options.store, Date.now, { persist: false }),
            catch: validationProblem,
          }).pipe(Effect.tapError(() => cleanup(options.store, received)))
          const result = yield* Effect.tryPromise({
            try: () =>
              options.submissions.create(principal, {
                idempotencyKey,
                target: state.target ?? "company",
                audience: state.audience,
                submissionID,
                verifiedSkillID: validated.skillID,
                metadata: received.metadata,
                package: received.package,
                icon: submissionIcon(received.icon),
              }),
            catch: createProblem,
          }).pipe(Effect.tapError(() => cleanup(options.store, received)))
          if (result.submission.id !== submissionID) yield* cleanup(options.store, received)
          options.emit?.({ skill_market_upload_count: 1 })
          return result
        }),
      )
      .handle("skillMarket.submissions.detail", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.submissions.getOwn(principal, context.params.submissionID),
            catch: readProblem,
          })
        }),
      )
      .handleRaw("skillMarket.submissions.package", (context) =>
        personalPackage(options, context.params.submissionID, false),
      )
      .handleRaw("skillMarket.submissions.packageHead", (context) =>
        personalPackage(options, context.params.submissionID, true),
      )
      .handle("skillMarket.submissions.revise", (context) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const idempotencyKey = yield* readIdempotencyKey(request.headers["idempotency-key"])
          const detail = yield* Effect.tryPromise({
            try: () => options.submissions.getOwn(principal, context.params.submissionID),
            catch: reviseProblem,
          })
          const state: {
            expectedVersion?: number
            target?: SkillMarketControl.PublicationTarget
            audience?: SkillMarketControl.AudienceInput
          } = {}
          const received = yield* receive(
            context.payload,
            options,
            principal.session.user.employeeID,
            context.params.submissionID,
            detail.currentRevision + 1,
            "revise",
            state,
          )
          if (!state.expectedVersion) {
            yield* cleanup(options.store, received)
            return yield* new SkillMarketInvalidRequest({
              code: "invalid-request",
              message: "修订元数据缺少并发版本",
              requestId: requestID(),
            })
          }
          const result = yield* Effect.tryPromise({
            try: () =>
              options.submissions.addRevision(principal, context.params.submissionID, {
                idempotencyKey,
                expectedVersion: state.expectedVersion!,
                metadata: received.metadata,
                package: received.package,
                icon: submissionIcon(received.icon),
              }),
            catch: reviseProblem,
          }).pipe(Effect.tapError(() => cleanup(options.store, received)))
          options.emit?.({ skill_market_upload_count: 1 })
          return result
        }),
      ),
  )
  const sharing = HttpApiBuilder.group(SkillMarketApi, "skillMarket.submissionSharing", (handlers) =>
    handlers
      .handle("skillMarket.submissions.promote", (context) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const idempotencyKey = yield* readIdempotencyKey(request.headers["idempotency-key"])
          return yield* Effect.tryPromise({
            try: () =>
              options.submissions.promote(principal, context.params.submissionID, {
                ...context.payload,
                idempotencyKey,
              }),
            catch: reviseProblem,
          })
        }),
      )
      .handle("skillMarket.submissions.audienceChange", (context) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          const idempotencyKey = yield* readIdempotencyKey(request.headers["idempotency-key"])
          return yield* Effect.tryPromise({
            try: () =>
              options.submissions.changeAudience(principal, context.params.submissionID, {
                ...context.payload,
                idempotencyKey,
              }),
            catch: reviseProblem,
          })
        }),
      ),
  )
  const lifecycle = HttpApiBuilder.group(SkillMarketApi, "skillMarket.submissionLifecycle", (handlers) =>
    handlers
      .handle("skillMarket.submissions.personalTrash", () =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({ try: () => options.personalTrash.list(principal), catch: dependencyProblem })
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
            catch: reviseProblem,
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
            catch: reviseProblem,
          })
        }),
      )
      .handle("skillMarket.submissions.withdraw", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.submissions.withdraw(principal, context.params.submissionID, context.payload),
            catch: reviseProblem,
          })
        }),
      )
      .handle("skillMarket.submissions.requestDelist", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.submissions.requestDelist(principal, context.params.submissionID, context.payload),
            catch: reviseProblem,
          })
        }),
      )
      .handle("skillMarket.submissions.pendingDelist", (context) =>
        Effect.gen(function* () {
          const principal = principalFromSession(yield* SkillMarketPrincipal)
          return yield* Effect.tryPromise({
            try: () => options.submissions.pendingDelist(principal, context.params.submissionID),
            catch: readProblem,
          })
        }),
      ),
  )
  return Layer.mergeAll(submissions, sharing, lifecycle)
}

function receive(
  stream: Stream.Stream<Multipart.Part, Multipart.MultipartError>,
  options: SubmissionsHttpOptions,
  employeeID: string,
  submissionID: SkillMarketControl.SubmissionID,
  revision: number,
  mode: "create" | "revise",
  state: {
    expectedVersion?: number
    target?: SkillMarketControl.PublicationTarget
    audience?: SkillMarketControl.AudienceInput
  } = {},
) {
  return Effect.tryPromise({
    try: () =>
      receiveSubmission(parts(stream, mode, state), {
        store: options.store,
        privatePrefix: options.privatePrefix,
        employeeID,
        submissionID,
        revision,
      }),
    catch: uploadProblem,
  })
}

async function* parts(
  stream: Stream.Stream<Multipart.Part, Multipart.MultipartError>,
  mode: "create" | "revise",
  state: {
    expectedVersion?: number
    target?: SkillMarketControl.PublicationTarget
    audience?: SkillMarketControl.AudienceInput
  },
): AsyncIterable<SubmissionPart> {
  for await (const part of Stream.toAsyncIterable(stream)) {
    if (Multipart.isField(part)) {
      if (part.key !== "metadata") throw new Error("multipart field is not supported")
      if (mode === "create") {
        const json = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(part.value)
        const input = Schema.decodeUnknownOption(SkillMarketControl.SubmissionCreateInput)(json)
        if (Option.isSome(input)) {
          state.target = input.value.target
          state.audience = input.value.audience
          yield { type: "field", name: "metadata", value: JSON.stringify(input.value.metadata) }
          continue
        }
        state.target = "company"
        yield {
          type: "field",
          name: "metadata",
          value: JSON.stringify(Schema.decodeUnknownSync(SkillMarketControl.SubmissionMetadata)(json)),
        }
        continue
      }
      const json = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(part.value)
      const input = Schema.decodeUnknownSync(SkillMarketControl.RevisionInput)(json)
      state.expectedVersion = input.expectedVersion
      yield { type: "field", name: "metadata", value: JSON.stringify(input.metadata) }
      continue
    }
    if (!Multipart.isFile(part) || (part.key !== "package" && part.key !== "icon"))
      throw new Error("multipart file is not supported")
    yield {
      type: "file",
      name: part.key,
      filename: part.name,
      contentType: part.contentType,
      stream: Stream.toAsyncIterable(part.content),
    }
  }
}

function personalPackage(options: SubmissionsHttpOptions, submissionID: string, head: boolean) {
  return Effect.gen(function* () {
    const principal = principalFromSession(yield* SkillMarketPrincipal)
    const identity = yield* Effect.tryPromise({
      try: () => options.submissions.personalPackage(principal, submissionID),
      catch: (error) => error,
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed(
            error instanceof SkillMarketSecurityError && error.code === "not-found"
              ? HttpServerResponse.jsonUnsafe(
                  { code: "not-found", message: "个人 Skill 不存在", requestId: requestID() },
                  { status: 404 },
                )
              : HttpServerResponse.jsonUnsafe(
                  { code: "dependency-unavailable", message: "个人空间暂不可用", requestId: requestID() },
                  { status: 503 },
                ),
          ),
        onSuccess: Effect.succeed,
      }),
    )
    if (HttpServerResponse.isHttpServerResponse(identity)) return identity
    const verified = yield* Effect.tryPromise({
      try: async () => {
        const metadata = await options.store.head(identity.key)
        if (metadata.size !== identity.size) throw new Error("personal package size mismatch")
        if (head) return undefined
        const body = await options.store.get(identity.key)
        if (
          body.byteLength !== identity.size ||
          new Bun.CryptoHasher("sha256").update(body).digest("hex") !== identity.sha256
        )
          throw new Error("personal package integrity mismatch")
        return body
      },
      catch: () => undefined,
    }).pipe(
      Effect.match({
        onFailure: () =>
          HttpServerResponse.jsonUnsafe(
            { code: "dependency-unavailable", message: "个人 Skill 包暂不可用", requestId: requestID() },
            { status: 502 },
          ),
        onSuccess: (body) => body,
      }),
    )
    if (HttpServerResponse.isHttpServerResponse(verified)) return verified
    const headers = {
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${identity.filename}"`,
      "content-length": String(identity.size),
      "content-type": "application/zip",
      etag: `"${identity.sha256}"`,
      "x-content-sha256": identity.sha256,
    }
    if (head) return HttpServerResponse.empty({ status: 200, headers })
    if (!verified)
      return HttpServerResponse.jsonUnsafe(
        { code: "dependency-unavailable", message: "个人 Skill 包暂不可用", requestId: requestID() },
        { status: 502 },
      )
    return HttpServerResponse.uint8Array(verified, { headers })
  })
}

function cleanup(store: PrivateObjectStore, received: ReceivedSubmission) {
  const directory = received.package.key.replace(/package\.zip$/, "")
  return Effect.promise(() =>
    Promise.all(
      [received.package.key, received.icon?.key, `${directory}manifest.json`, `${directory}scan.json`].flatMap((key) =>
        key ? [store.delete(key).catch(() => undefined)] : [],
      ),
    ).then(() => undefined),
  )
}

function readIdempotencyKey(value: string | undefined) {
  if (value && /^[\x21-\x7e]{8,200}$/.test(value)) return Effect.succeed(value)
  return Effect.fail(
    new SkillMarketInvalidRequest({
      code: "invalid-request",
      message: "缺少有效的 Idempotency-Key",
      requestId: requestID(),
    }),
  )
}

function submissionIcon(icon: ReceivedSubmission["icon"]): SubmissionIcon | undefined {
  if (!icon) return undefined
  if (
    icon.mime !== "image/png" &&
    icon.mime !== "image/jpeg" &&
    icon.mime !== "image/webp" &&
    icon.mime !== "image/svg+xml"
  )
    throw new Error("validated submission icon has an invalid MIME type")
  return { ...icon, mime: icon.mime }
}

function uploadProblem(error: unknown) {
  if (String(error).includes("size limit") || String(error).includes("FileTooLarge"))
    return new SkillMarketUploadTooLarge({
      code: "upload-too-large",
      message: "上传文件超过大小限制",
      requestId: requestID(),
    })
  return new SkillMarketInvalidRequest({
    code: "invalid-request",
    message: "multipart 投稿内容无效",
    requestId: requestID(),
  })
}

function validationProblem() {
  return new SkillMarketValidationFailed({
    code: "validation-failed",
    message: "Skill 压缩包校验失败",
    requestId: requestID(),
  })
}

function dependencyProblem() {
  return new SkillMarketDependencyUnavailable({
    code: "dependency-unavailable",
    message: "投稿服务暂不可用",
    requestId: requestID(),
  })
}

function readProblem(error: unknown) {
  if (error instanceof SkillMarketSecurityError && error.code === "not-found")
    return new SkillMarketControlNotFound({ code: "not-found", message: "投稿不存在", requestId: requestID() })
  return dependencyProblem()
}

function createProblem(error: unknown) {
  if (!(error instanceof SkillMarketSecurityError)) return dependencyProblem()
  if (error.code === "forbidden")
    return new SkillMarketForbidden({
      code: error.code,
      message: "没有提交此 Skill 的权限",
      requestId: requestID(),
    })
  if (error.code === "invalid-request")
    return new SkillMarketInvalidRequest({ code: error.code, message: "投稿请求无效", requestId: requestID() })
  if (error.code === "submission-conflict")
    return new SkillMarketSubmissionConflict({
      code: error.code,
      message: "投稿状态已发生变化，请刷新后重试",
      requestId: requestID(),
    })
  if (error.code === "skill-owned-by-another-user")
    return new SkillMarketOwnershipConflict({
      code: error.code,
      message: "此 Skill ID 已属于其他投稿者",
      requestId: requestID(),
    })
  if (error.code === "upload-rate-limited")
    return new SkillMarketUploadRateLimited({
      code: error.code,
      message: "上传次数已达到限制，请稍后重试",
      requestId: requestID(),
    })
  return dependencyProblem()
}

function reviseProblem(error: unknown) {
  if (error instanceof SkillMarketSecurityError && error.code === "not-found")
    return new SkillMarketControlNotFound({ code: "not-found", message: "投稿不存在", requestId: requestID() })
  return createProblem(error)
}
