import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  SkillMarketControlNotFound,
  SkillMarketDependencyUnavailable,
  SkillMarketForbidden,
  SkillMarketInvalidRequest,
  SkillMarketLastAdmin,
  SkillMarketSubmissionConflict,
} from "../skill-market-errors"
import {
  SkillMarketAdminMiddleware,
  SkillMarketReviewerMiddleware,
  SkillMarketSessionMiddleware,
  SkillMarketWriteMiddleware,
} from "../skill-market-middleware"

const PageNumber = Schema.NumberFromString.pipe(Schema.decodeTo(SkillMarketControl.AdminSubmissionQuery.fields.page))
const PageLimit = Schema.NumberFromString.pipe(Schema.decodeTo(SkillMarketControl.AdminSubmissionQuery.fields.limit))
const SubmissionParams = { submissionID: SkillMarketControl.SubmissionID }
const SkillParams = { skillID: SkillMarketControl.SubmissionSummary.fields.skillID }
const ReviewErrors = [
  SkillMarketInvalidRequest,
  SkillMarketControlNotFound,
  SkillMarketSubmissionConflict,
  SkillMarketDependencyUnavailable,
] as const

const ReviewerEndpoints = HttpApiGroup.make("skillMarket.admin")
  .add(
    HttpApiEndpoint.get("skillMarket.admin.submissions.list", "/v1/admin/submissions", {
      query: Schema.Struct({
        status: SkillMarketControl.SubmissionStatus.pipe(Schema.optional),
        risk: SkillMarketControl.SubmissionSummary.fields.risk.pipe(Schema.optional),
        submitter: SkillMarketControl.EmployeeID.pipe(Schema.optional),
        createdFrom: SkillMarketControl.SubmissionSummary.fields.createdAt.pipe(Schema.optional),
        createdTo: SkillMarketControl.SubmissionSummary.fields.createdAt.pipe(Schema.optional),
        page: PageNumber.pipe(Schema.optional),
        limit: PageLimit.pipe(Schema.optional),
      }),
      success: SkillMarketControl.SubmissionPage,
      error: SkillMarketDependencyUnavailable,
    }),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.admin.submissions.detail", "/v1/admin/submissions/:submissionID", {
      params: SubmissionParams,
      success: SkillMarketControl.SubmissionDetail,
      error: [SkillMarketControlNotFound, SkillMarketDependencyUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.submissions.decision", "/v1/admin/submissions/:submissionID/decision", {
      params: SubmissionParams,
      payload: SkillMarketControl.DecisionInput,
      success: SkillMarketControl.SubmissionDetail,
      error: ReviewErrors,
    }).middleware(SkillMarketWriteMiddleware),
  )
  .middleware(SkillMarketReviewerMiddleware)

export const SkillMarketAdminGroup = ReviewerEndpoints.add(
  HttpApiEndpoint.post("skillMarket.admin.submissions.retry", "/v1/admin/submissions/:submissionID/retry-publish", {
    params: SubmissionParams,
    payload: SkillMarketControl.ExpectedVersionInput,
    success: SkillMarketControl.SubmissionDetail,
    error: ReviewErrors,
  })
    .middleware(SkillMarketWriteMiddleware)
    .middleware(SkillMarketAdminMiddleware),
)
  .add(
    HttpApiEndpoint.get("skillMarket.admin.skillhub.status", "/v1/admin/skillhub-import", {
      success: SkillMarketControl.SkillHubImportProgress,
      error: [SkillMarketForbidden, SkillMarketDependencyUnavailable],
    }).middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.skillhub.command", "/v1/admin/skillhub-import/command", {
      payload: SkillMarketControl.SkillHubImportCommandInput,
      success: SkillMarketControl.SkillHubImportProgress,
      error: [SkillMarketForbidden, SkillMarketInvalidRequest, SkillMarketDependencyUnavailable],
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.admin.skillhub.evaluation", "/v1/admin/skillhub-evaluation", {
      success: SkillMarketControl.SkillHubEvaluationProgress,
      error: [SkillMarketForbidden, SkillMarketDependencyUnavailable],
    }).middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.announcements.create", "/v1/admin/announcements", {
      payload: SkillMarketControl.AnnouncementCreateInput,
      success: SkillMarket.AnnouncementDetail,
      error: [SkillMarketInvalidRequest, SkillMarketDependencyUnavailable],
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.admin.roles.list", "/v1/admin/roles", {
      success: Schema.Array(SkillMarketControl.RoleAssignment),
      error: SkillMarketDependencyUnavailable,
    }).middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.roles.create", "/v1/admin/roles", {
      payload: SkillMarketControl.RoleInput,
      success: SkillMarketControl.RoleAssignment,
      error: [SkillMarketInvalidRequest, SkillMarketDependencyUnavailable],
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.delete("skillMarket.admin.roles.delete", "/v1/admin/roles/:employeeID/:role", {
      params: { employeeID: SkillMarketControl.EmployeeID, role: SkillMarketControl.Role },
      success: Schema.Array(SkillMarketControl.RoleAssignment),
      error: [SkillMarketControlNotFound, SkillMarketLastAdmin, SkillMarketDependencyUnavailable],
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.admin.audit.list", "/v1/admin/audit", {
      query: Schema.Struct({
        actor: SkillMarketControl.EmployeeID.pipe(Schema.optional),
        action: SkillMarketControl.AuditAction.pipe(Schema.optional),
        objectType: SkillMarketControl.AuditObjectType.pipe(Schema.optional),
        objectID: SkillMarketControl.AuditEvent.fields.objectID.pipe(Schema.optional),
        createdFrom: SkillMarketControl.AuditEvent.fields.createdAt.pipe(Schema.optional),
        createdTo: SkillMarketControl.AuditEvent.fields.createdAt.pipe(Schema.optional),
        page: PageNumber.pipe(Schema.optional),
        limit: PageLimit.pipe(Schema.optional),
      }),
      success: SkillMarketControl.AuditPage,
      error: SkillMarketDependencyUnavailable,
    }).middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.community.delist", "/v1/admin/community-skills/:skillID/delist", {
      params: SkillParams,
      payload: SkillMarketControl.ReasonInput,
      success: SkillMarketControl.PublicSkill,
      error: ReviewErrors,
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.community.restore", "/v1/admin/community-skills/:skillID/restore", {
      params: SkillParams,
      payload: SkillMarketControl.ReasonInput,
      success: SkillMarketControl.PublicSkill,
      error: ReviewErrors,
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .middleware(SkillMarketSessionMiddleware)
  .annotateMerge(
    OpenApi.annotations({ title: "Ruying Skill Market Administration", description: "Review and administration." }),
  )
