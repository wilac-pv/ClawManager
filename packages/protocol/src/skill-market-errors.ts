import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"

const fields = (code: SkillMarketControl.ProblemCode) => ({
  code: Schema.Literal(code),
  message: Schema.String,
  requestId: SkillMarketControl.RequestID,
})

export class SkillMarketInvalidRequest extends Schema.ErrorClass<SkillMarketInvalidRequest>(
  "SkillMarketInvalidRequest",
)(fields("invalid-request"), { httpApiStatus: 400 }) {}

export class SkillMarketUnauthenticated extends Schema.ErrorClass<SkillMarketUnauthenticated>(
  "SkillMarketUnauthenticated",
)(fields("unauthenticated"), { httpApiStatus: 401 }) {}

export class SkillMarketForbidden extends Schema.ErrorClass<SkillMarketForbidden>("SkillMarketForbidden")(
  fields("forbidden"),
  { httpApiStatus: 403 },
) {}

export class SkillMarketCsrfInvalid extends Schema.ErrorClass<SkillMarketCsrfInvalid>("SkillMarketCsrfInvalid")(
  fields("csrf-invalid"),
  { httpApiStatus: 403 },
) {}

export class SkillMarketControlNotFound extends Schema.ErrorClass<SkillMarketControlNotFound>(
  "SkillMarketControlNotFound",
)(fields("not-found"), { httpApiStatus: 404 }) {}

export class SkillMarketSubmissionConflict extends Schema.ErrorClass<SkillMarketSubmissionConflict>(
  "SkillMarketSubmissionConflict",
)(fields("submission-conflict"), { httpApiStatus: 409 }) {}

export class SkillMarketOwnershipConflict extends Schema.ErrorClass<SkillMarketOwnershipConflict>(
  "SkillMarketOwnershipConflict",
)(fields("skill-owned-by-another-user"), { httpApiStatus: 409 }) {}

export class SkillMarketLastAdmin extends Schema.ErrorClass<SkillMarketLastAdmin>("SkillMarketLastAdmin")(
  fields("last-admin"),
  { httpApiStatus: 409 },
) {}

export class SkillMarketUploadTooLarge extends Schema.ErrorClass<SkillMarketUploadTooLarge>(
  "SkillMarketUploadTooLarge",
)(fields("upload-too-large"), { httpApiStatus: 413 }) {}

export class SkillMarketValidationFailed extends Schema.ErrorClass<SkillMarketValidationFailed>(
  "SkillMarketValidationFailed",
)(fields("validation-failed"), { httpApiStatus: 422 }) {}

export class SkillMarketUploadRateLimited extends Schema.ErrorClass<SkillMarketUploadRateLimited>(
  "SkillMarketUploadRateLimited",
)(fields("upload-rate-limited"), { httpApiStatus: 429 }) {}

export class SkillMarketDependencyUnavailable extends Schema.ErrorClass<SkillMarketDependencyUnavailable>(
  "SkillMarketDependencyUnavailable",
)(fields("dependency-unavailable"), { httpApiStatus: 503 }) {}
