import { SkillMarketApi } from "@opencode-ai/protocol/skill-market-api"
import {
  SkillMarketDependencyUnavailable,
  SkillMarketInvalidRequest,
  SkillMarketUnauthenticated,
} from "@opencode-ai/protocol/skill-market-errors"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { createAuth } from "../auth"
import type { MarketMetricEmitter } from "../metrics"
import { SkillMarketSecurityError } from "../security"
import { readCookies, requestID } from "./middleware"

interface AuthHttpOptions {
  readonly auth: ReturnType<typeof createAuth>
  readonly webOrigin: string
  readonly webBaseUrl: string
  readonly sessionCookieName: string
  readonly cookieSecure: boolean
  readonly emit?: MarketMetricEmitter
}

export function createAuthHttp(options: AuthHttpOptions) {
  const csrfCookieName = options.sessionCookieName.replace(/session$/, "csrf")
  return HttpApiBuilder.group(SkillMarketApi, "skillMarket.auth", (handlers) =>
    handlers
      .handle("skillMarket.auth.login", (context) =>
        Effect.try({
          try: () => HttpServerResponse.redirect(options.auth.begin(context.query.returnTo).authorizationUrl),
          catch: authProblem,
        }),
      )
      .handle("skillMarket.auth.callback", (context) => {
        if (context.query.error) {
          options.emit?.({ skill_market_sso_result: { failure: 1 } })
          return Effect.fail(
            new SkillMarketUnauthenticated({
              code: "unauthenticated",
              message: "SSO 登录未完成",
              requestId: requestID(),
            }),
          )
        }
        const token = context.query.access_token ?? context.query.token
        if (!token) {
          options.emit?.({ skill_market_sso_result: { failure: 1 } })
          return Effect.fail(
            new SkillMarketInvalidRequest({
              code: "invalid-request",
              message: "SSO 回调缺少登录凭据",
              requestId: requestID(),
            }),
          )
        }
        return Effect.tryPromise({
          try: () => options.auth.complete(context.params.attemptID, token),
          catch: authProblem,
        }).pipe(
          Effect.tap(() => Effect.sync(() => options.emit?.({ skill_market_sso_result: { success: 1 } }))),
          Effect.tapError(() => Effect.sync(() => options.emit?.({ skill_market_sso_result: { failure: 1 } }))),
          Effect.map((result) =>
            HttpServerResponse.redirect(new URL(result.returnTo.slice(1), options.webBaseUrl), {
              cookies: HttpServerResponse.setCookiesUnsafe(HttpServerResponse.empty(), [
                [
                  options.sessionCookieName,
                  result.sessionToken,
                  { path: "/", httpOnly: true, secure: options.cookieSecure, sameSite: "lax" },
                ],
                [
                  csrfCookieName,
                  result.csrfToken,
                  { path: "/", httpOnly: false, secure: options.cookieSecure, sameSite: "lax" },
                ],
              ]).cookies,
            }),
          ),
        )
      })
      .handle("skillMarket.auth.session", () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const cookies = readCookies(request.headers.cookie)
          return yield* Effect.try({
            try: () =>
              options.auth.session(cookies.get(options.sessionCookieName) ?? "", cookies.get(csrfCookieName) ?? ""),
            catch: () => undefined,
          }).pipe(
            Effect.match({
              onFailure: () => null,
              onSuccess: (session) => session,
            }),
          )
        }),
      )
      .handle("skillMarket.auth.logout", () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const cookies = readCookies(request.headers.cookie)
          options.auth.logout(cookies.get(options.sessionCookieName) ?? "")
          return HttpServerResponse.setCookiesUnsafe(HttpServerResponse.empty(), [
            [
              options.sessionCookieName,
              "",
              { path: "/", httpOnly: true, secure: options.cookieSecure, sameSite: "lax", maxAge: 0 },
            ],
            [
              csrfCookieName,
              "",
              { path: "/", httpOnly: false, secure: options.cookieSecure, sameSite: "lax", maxAge: 0 },
            ],
          ])
        }),
      ),
  )
}

function authProblem(error: unknown) {
  const code = error instanceof SkillMarketSecurityError ? error.code : "dependency-unavailable"
  if (code === "invalid-request")
    return new SkillMarketInvalidRequest({
      code,
      message: "登录请求无效",
      requestId: requestID(),
    })
  if (code === "unauthenticated")
    return new SkillMarketUnauthenticated({
      code,
      message: "SSO 登录无效或已过期",
      requestId: requestID(),
    })
  return new SkillMarketDependencyUnavailable({
    code: "dependency-unavailable",
    message: "登录服务暂不可用",
    requestId: requestID(),
  })
}
