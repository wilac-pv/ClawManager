import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  SkillMarketControlNotFound,
  SkillMarketDependencyUnavailable,
  SkillMarketInvalidRequest,
  SkillMarketOwnershipConflict,
  SkillMarketSubmissionConflict,
  SkillMarketUploadRateLimited,
  SkillMarketUploadTooLarge,
  SkillMarketValidationFailed,
} from "../skill-market-errors"
import {
  SkillMarketSessionMiddleware,
  SkillMarketWriteMiddleware,
  SkillMarketWriteOpenApi,
} from "../skill-market-middleware"

const PageNumber = Schema.NumberFromString.pipe(Schema.decodeTo(SkillMarketControl.SubmissionListQuery.fields.page))
const PageLimit = Schema.NumberFromString.pipe(Schema.decodeTo(SkillMarketControl.SubmissionListQuery.fields.limit))
const Upload = Schema.Unknown.pipe(
  HttpApiSchema.asMultipartStream({
    maxParts: 3,
    maxFieldSize: 64 * 1024,
    maxFileSize: 50 * 1024 * 1024,
    maxTotalSize: 52 * 1024 * 1024,
  }),
)
const WriteErrors = [
  SkillMarketInvalidRequest,
  SkillMarketSubmissionConflict,
  SkillMarketOwnershipConflict,
  SkillMarketUploadTooLarge,
  SkillMarketValidationFailed,
  SkillMarketUploadRateLimited,
  SkillMarketDependencyUnavailable,
] as const

export const SkillMarketSubmissionsGroup = HttpApiGroup.make("skillMarket.submissions")
  .add(
    HttpApiEndpoint.get("skillMarket.submissions.list", "/v1/submissions", {
      query: Schema.Struct({
        status: SkillMarketControl.SubmissionStatus.pipe(Schema.optional),
        target: SkillMarketControl.PublicationTarget.pipe(Schema.optional),
        page: PageNumber.pipe(Schema.optional),
        limit: PageLimit.pipe(Schema.optional),
      }),
      success: SkillMarketControl.SubmissionPage,
      error: SkillMarketDependencyUnavailable,
    }),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.submissions.create", "/v1/submissions", {
      payload: Upload,
      success: SkillMarketControl.AcceptedSubmission.pipe(HttpApiSchema.status(202)),
      error: WriteErrors,
    }).middleware(SkillMarketWriteMiddleware),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.submissions.detail", "/v1/submissions/:submissionID", {
      params: { submissionID: SkillMarketControl.SubmissionID },
      success: SkillMarketControl.SubmissionDetail,
      error: [SkillMarketControlNotFound, SkillMarketDependencyUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.submissions.package", "/v1/submissions/:submissionID/package", {
      params: { submissionID: SkillMarketControl.SubmissionID },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: [SkillMarketControlNotFound, SkillMarketDependencyUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.head("skillMarket.submissions.packageHead", "/v1/submissions/:submissionID/package", {
      params: { submissionID: SkillMarketControl.SubmissionID },
      success: HttpApiSchema.Empty(200),
      error: [SkillMarketControlNotFound, SkillMarketDependencyUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.submissions.revise", "/v1/submissions/:submissionID/revisions", {
      params: { submissionID: SkillMarketControl.SubmissionID },
      payload: Upload,
      success: SkillMarketControl.AcceptedSubmission.pipe(HttpApiSchema.status(202)),
      error: [SkillMarketControlNotFound, ...WriteErrors],
    }).middleware(SkillMarketWriteMiddleware),
  )
  .middleware(SkillMarketSessionMiddleware)
  .annotateMerge(
    OpenApi.annotations({ title: "Ruying Skill Submissions", description: "Authenticated user submissions." }),
  )

export const SkillMarketSubmissionSharingGroup = HttpApiGroup.make("skillMarket.submissionSharing")
  .add(
    HttpApiEndpoint.post("skillMarket.submissions.promote", "/v1/submissions/:submissionID/promotions", {
      params: { submissionID: SkillMarketControl.SubmissionID },
      payload: SkillMarketControl.PromotionInput,
      success: SkillMarketControl.AcceptedSubmission.pipe(HttpApiSchema.status(202)),
      error: [SkillMarketControlNotFound, ...WriteErrors],
    }).middleware(SkillMarketWriteMiddleware).annotateMerge(SkillMarketWriteOpenApi),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.submissions.audienceChange", "/v1/submissions/:submissionID/audience-changes", {
      params: { submissionID: SkillMarketControl.SubmissionID },
      payload: SkillMarketControl.AudienceChangeInput,
      success: SkillMarketControl.AcceptedSubmission.pipe(HttpApiSchema.status(202)),
      error: [SkillMarketControlNotFound, ...WriteErrors],
    }).middleware(SkillMarketWriteMiddleware).annotateMerge(SkillMarketWriteOpenApi),
  )
  .middleware(SkillMarketSessionMiddleware)
  .annotateMerge(
    OpenApi.annotations({ title: "Ruying Skill Submission Sharing", description: "Reviewed audience changes." }),
  )
