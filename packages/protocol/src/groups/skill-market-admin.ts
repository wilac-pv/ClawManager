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
  .add(
    HttpApiEndpoint.get("skillMarket.admin.skills.list", "/v1/admin/skills", {
      query: Schema.Struct({
        page: PageNumber.pipe(Schema.optional),
        limit: PageLimit.pipe(Schema.optional),
        query: SkillMarketControl.SkillAdminListQuery.fields.query.pipe(Schema.optional),
        source: SkillMarketControl.SkillAdminListQuery.fields.source.pipe(Schema.optional),
        category: SkillMarketControl.SkillAdminListQuery.fields.category.pipe(Schema.optional),
        hidden: Schema.Literals(["true", "false"]).pipe(Schema.optional),
        featured: Schema.Literals(["true", "false"]).pipe(Schema.optional),
      }),
      success: SkillMarketControl.SkillAdminPage,
      error: SkillMarketDependencyUnavailable,
    }).middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.admin.skills.hiddenCategories", "/v1/admin/skills/hidden-categories", {
      success: SkillMarketControl.HiddenCategoryList,
      error: SkillMarketDependencyUnavailable,
    }).middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.skills.delistByCategory", "/v1/admin/skills/delist-by-category", {
      payload: SkillMarketControl.SkillAdminCategoryActionInput,
      success: Schema.Void,
      error: ReviewErrors,
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.skills.restoreByCategory", "/v1/admin/skills/restore-by-category", {
      payload: SkillMarketControl.SkillAdminCategoryActionInput,
      success: Schema.Void,
      error: ReviewErrors,
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.patch("skillMarket.admin.skills.update", "/v1/admin/skills/:source/:skillID", {
      params: { source: SkillMarket.Source, skillID: SkillMarketControl.SubmissionSummary.fields.skillID },
      payload: SkillMarketControl.SkillAdminEditInput,
      success: SkillMarketControl.SkillAdminItem,
      error: ReviewErrors,
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.skills.delist", "/v1/admin/skills/:source/:skillID/delist", {
      params: { source: SkillMarket.Source, skillID: SkillMarketControl.SubmissionSummary.fields.skillID },
      payload: SkillMarketControl.ReasonInput,
      success: SkillMarketControl.SkillAdminItem,
      error: ReviewErrors,
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.skills.restore", "/v1/admin/skills/:source/:skillID/restore", {
      params: { source: SkillMarket.Source, skillID: SkillMarketControl.SubmissionSummary.fields.skillID },
      payload: SkillMarketControl.ReasonInput,
      success: SkillMarketControl.SkillAdminItem,
      error: ReviewErrors,
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .middleware(SkillMarketSessionMiddleware)
  .annotateMerge(
    OpenApi.annotations({ title: "Ruying Skill Market Administration", description: "Review and administration." }),
  )

export const SkillMarketAdminLifecycleGroup = HttpApiGroup.make("skillMarket.adminLifecycle")
  .add(
    HttpApiEndpoint.get("skillMarket.admin.pendingDelist", "/v1/admin/submissions/:submissionID/delist-requests", {
      params: { submissionID: SkillMarketControl.SubmissionID },
      success: Schema.Array(SkillMarketControl.DelistRequest),
      error: ReviewErrors,
    }).middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.admin.listDelist", "/v1/admin/delist-requests", {
      query: Schema.Struct({
        page: PageNumber.pipe(Schema.optional),
        limit: PageLimit.pipe(Schema.optional),
      }),
      success: SkillMarketControl.DelistRequestPage,
      error: ReviewErrors,
    }).middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.approveDelist", "/v1/admin/delist-requests/:requestID/approve", {
      params: { requestID: SkillMarketControl.DelistRequestID },
      payload: SkillMarketControl.ExpectedVersionInput,
      success: SkillMarketControl.DelistRequest,
      error: ReviewErrors,
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.admin.rejectDelist", "/v1/admin/delist-requests/:requestID/reject", {
      params: { requestID: SkillMarketControl.DelistRequestID },
      payload: SkillMarketControl.ExpectedVersionInput,
      success: SkillMarketControl.DelistRequest,
      error: ReviewErrors,
    })
      .middleware(SkillMarketWriteMiddleware)
      .middleware(SkillMarketAdminMiddleware),
  )
  .middleware(SkillMarketSessionMiddleware)
  .annotateMerge(
    OpenApi.annotations({ title: "Ruying Skill Market Lifecycle Administration", description: "Delisting decisions." }),
  )
