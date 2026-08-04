import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Context } from "effect"
import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/unstable/httpapi"
import { SkillMarketCsrfInvalid, SkillMarketForbidden, SkillMarketUnauthenticated } from "./skill-market-errors"

export class SkillMarketPrincipal extends Context.Service<SkillMarketPrincipal, SkillMarketControl.Session>()(
  "@opencode/SkillMarketPrincipal",
) {}

export class SkillMarketSessionMiddleware extends HttpApiMiddleware.Service<
  SkillMarketSessionMiddleware,
  { provides: SkillMarketPrincipal }
>()("@opencode/SkillMarketSessionMiddleware", {
  error: SkillMarketUnauthenticated,
  security: {
    session: HttpApiSecurity.apiKey({ key: "__Host-ruying_market_session", in: "cookie" }),
  },
}) {}

export class SkillMarketWriteMiddleware extends HttpApiMiddleware.Service<
  SkillMarketWriteMiddleware,
  { requires: SkillMarketPrincipal }
>()("@opencode/SkillMarketWriteMiddleware", {
  error: [SkillMarketCsrfInvalid, SkillMarketForbidden],
  security: { csrf: HttpApiSecurity.apiKey({ key: "X-CSRF-Token", in: "header" }) },
}) {}

// Runtime composes session and CSRF middleware; override Effect's alternative-scheme output to document that AND.
export const SkillMarketWriteOpenApi = OpenApi.annotations({
  override: { security: [{ session: [], csrf: [] }] },
})

export class SkillMarketReviewerMiddleware extends HttpApiMiddleware.Service<
  SkillMarketReviewerMiddleware,
  { requires: SkillMarketPrincipal }
>()("@opencode/SkillMarketReviewerMiddleware", { error: SkillMarketForbidden }) {}

export class SkillMarketAdminMiddleware extends HttpApiMiddleware.Service<
  SkillMarketAdminMiddleware,
  { requires: SkillMarketPrincipal }
>()("@opencode/SkillMarketAdminMiddleware", { error: SkillMarketForbidden }) {}
