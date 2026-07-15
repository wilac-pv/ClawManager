import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  SkillMarketDependencyUnavailable,
  SkillMarketInvalidRequest,
  SkillMarketUnauthenticated,
} from "../skill-market-errors"
import { SkillMarketSessionMiddleware, SkillMarketWriteMiddleware } from "../skill-market-middleware"

const AttemptID = Schema.String.check(Schema.isPattern(/^login_[a-zA-Z0-9_-]{8,64}$/))

export const SkillMarketAuthGroup = HttpApiGroup.make("skillMarket.auth")
  .add(
    HttpApiEndpoint.get("skillMarket.auth.login", "/v1/auth/login", {
      query: Schema.Struct({ returnTo: Schema.String }),
      success: HttpApiSchema.Empty(302),
      error: [SkillMarketInvalidRequest, SkillMarketDependencyUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.auth.callback", "/v1/auth/callback/:attemptID", {
      params: { attemptID: AttemptID },
      query: Schema.Struct({
        access_token: Schema.String.pipe(Schema.optional),
        token: Schema.String.pipe(Schema.optional),
        error: Schema.String.pipe(Schema.optional),
      }),
      success: HttpApiSchema.Empty(302),
      error: [SkillMarketInvalidRequest, SkillMarketUnauthenticated, SkillMarketDependencyUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.auth.session", "/v1/auth/session", {
      success: SkillMarketControl.SessionState,
    }),
  )
  .add(
    HttpApiEndpoint.delete("skillMarket.auth.logout", "/v1/auth/session", {
      success: HttpApiSchema.NoContent,
      error: SkillMarketUnauthenticated,
    })
      .middleware(SkillMarketSessionMiddleware)
      .middleware(SkillMarketWriteMiddleware),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Ruying Skill Market Authentication",
      description: "GWM SSO login and cookie session operations.",
    }),
  )
