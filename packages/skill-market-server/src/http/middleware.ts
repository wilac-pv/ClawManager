import {
  SkillMarketAdminMiddleware,
  SkillMarketPrincipal,
  SkillMarketReviewerMiddleware,
  SkillMarketSessionMiddleware,
  SkillMarketWriteMiddleware,
} from "@opencode-ai/protocol/skill-market-middleware"
import {
  SkillMarketCsrfInvalid,
  SkillMarketForbidden,
  SkillMarketUnauthenticated,
} from "@opencode-ai/protocol/skill-market-errors"
import { Effect, Layer, Redacted } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import type { MarketMetricEmitter } from "../metrics"
import type { MarketSecurity, Principal } from "../security"
import { randomSecret, SkillMarketSecurityError } from "../security"

interface MiddlewareOptions {
  readonly security: MarketSecurity
  readonly sessionCookieName: string
  readonly emit?: MarketMetricEmitter
}

export function createSecurityLayers(options: MiddlewareOptions) {
  const csrfCookieName = options.sessionCookieName.replace(/session$/, "csrf")
  const session = Layer.succeed(
    SkillMarketSessionMiddleware,
    SkillMarketSessionMiddleware.of({
      session: (effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const cookies = readCookies(request.headers.cookie)
          const principal = yield* Effect.tryPromise({
            try: () =>
              options.security.requireSession({
                sessionToken: cookies.get(options.sessionCookieName) ?? "",
                csrfToken: cookies.get(csrfCookieName) ?? "",
              }),
            catch: () => {
              options.emit?.({ skill_market_session_rejection: { unauthenticated: 1 } })
              return unauthenticated()
            },
          })
          return yield* Effect.provideService(effect, SkillMarketPrincipal, principal.session)
        }),
    }),
  )
  const write = Layer.succeed(
    SkillMarketWriteMiddleware,
    SkillMarketWriteMiddleware.of({
      csrf: (effect, context) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const cookies = readCookies(request.headers.cookie)
          const principal = yield* Effect.tryPromise({
            try: () =>
              options.security.requireSession({
                sessionToken: cookies.get(options.sessionCookieName) ?? "",
                csrfToken: cookies.get(csrfCookieName) ?? "",
              }),
            catch: () => forbidden(),
          })
          yield* Effect.try({
            try: () =>
              options.security.requireWriteProtection(principal, {
                origin: request.headers.origin,
                csrfToken: Redacted.value(context.credential),
              }),
            catch: (error) => writeProblem(error),
          })
          return yield* effect
        }),
    }),
  )
  const reviewer = Layer.succeed(
    SkillMarketReviewerMiddleware,
    SkillMarketReviewerMiddleware.of((effect) =>
      Effect.gen(function* () {
        const principal = principalFromSession(yield* SkillMarketPrincipal)
        yield* Effect.try({
          try: () => options.security.requireReviewer(principal),
          catch: () => {
            options.emit?.({ skill_market_role_rejection: { reviewer: 1 } })
            return forbidden()
          },
        })
        return yield* effect
      }),
    ),
  )
  const admin = Layer.succeed(
    SkillMarketAdminMiddleware,
    SkillMarketAdminMiddleware.of((effect) =>
      Effect.gen(function* () {
        const principal = principalFromSession(yield* SkillMarketPrincipal)
        yield* Effect.try({
          try: () => options.security.requireAdmin(principal),
          catch: () => {
            options.emit?.({ skill_market_role_rejection: { admin: 1 } })
            return forbidden()
          },
        })
        return yield* effect
      }),
    ),
  )
  return [session, write, reviewer, admin] as const
}

export function principalFromSession(session: Principal["session"]): Principal {
  return { session, csrfHash: "" }
}

export function requestID() {
  return `req_${randomSecret().slice(0, 16)}`
}

export function readCookies(value: string | undefined) {
  return new Map(
    (value ?? "")
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .flatMap((entry) => {
        const separator = entry.indexOf("=")
        if (separator < 1) return []
        return [[entry.slice(0, separator), entry.slice(separator + 1)] as const]
      }),
  )
}

function unauthenticated() {
  return new SkillMarketUnauthenticated({
    code: "unauthenticated",
    message: "登录状态无效或已过期",
    requestId: requestID(),
  })
}

function forbidden() {
  return new SkillMarketForbidden({ code: "forbidden", message: "没有执行此操作的权限", requestId: requestID() })
}

function writeProblem(error: unknown) {
  if (error instanceof SkillMarketSecurityError && error.code === "csrf-invalid")
    return new SkillMarketCsrfInvalid({
      code: "csrf-invalid",
      message: "CSRF 校验失败，请刷新页面后重试",
      requestId: requestID(),
    })
  return forbidden()
}
