export * as SkillMarketControl from "./skill-market-control"

import { Schema } from "effect"
import { SkillMarket } from "./skill-market"
import { optional } from "./schema"

const bounded = (minimum: number, maximum: number) =>
  Schema.Trim.check(Schema.isLengthBetween(minimum, maximum))
const NonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const PageNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100_000))
const PageLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))

export const EmployeeID = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
).annotate({ identifier: "SkillMarketControl.EmployeeID" })
export type EmployeeID = typeof EmployeeID.Type

export const DepartmentID = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
).annotate({ identifier: "SkillMarketControl.DepartmentID" })
export type DepartmentID = typeof DepartmentID.Type

export interface Department extends Schema.Schema.Type<typeof Department> {}
export const Department = Schema.Struct({
  id: DepartmentID,
  name: bounded(1, 100),
}).annotate({ identifier: "SkillMarketControl.Department" })

export const SubmissionID = Schema.String.check(
  Schema.isPattern(/^sub_[a-zA-Z0-9_-]{8,64}$/),
).annotate({ identifier: "SkillMarketControl.SubmissionID" })
export type SubmissionID = typeof SubmissionID.Type

export const PublicationID = Schema.String.check(
  Schema.isPattern(/^pub_[a-zA-Z0-9_-]{8,64}$/),
).annotate({ identifier: "SkillMarketControl.PublicationID" })
export type PublicationID = typeof PublicationID.Type

export const RequestID = Schema.String.check(
  Schema.isPattern(/^req_[a-zA-Z0-9_-]{6,64}$/),
).annotate({ identifier: "SkillMarketControl.RequestID" })
export type RequestID = typeof RequestID.Type

export const SemVer = Schema.String.check(
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/,
  ),
).annotate({ identifier: "SkillMarketControl.SemVer" })
export type SemVer = typeof SemVer.Type

export const SubmissionStatus = Schema.Literals([
  "validating",
  "validation_failed",
  "pending_review",
  "changes_requested",
  "rejected",
  "publishing",
  "publish_failed",
  "published",
])
export type SubmissionStatus = typeof SubmissionStatus.Type

export const ActiveSubmissionStatuses = [
  "validating",
  "validation_failed",
  "pending_review",
  "changes_requested",
  "publishing",
  "publish_failed",
] as const satisfies ReadonlyArray<SubmissionStatus>

export const TerminalSubmissionStatuses = ["rejected", "published"] as const satisfies ReadonlyArray<SubmissionStatus>

export const ReviewDecision = Schema.Literals(["approve", "request_changes", "reject"])
export type ReviewDecision = typeof ReviewDecision.Type

export const Role = Schema.Literals(["reviewer", "admin"])
export type Role = typeof Role.Type

export const PublicStatus = Schema.Literals(["published", "delisted"])
export type PublicStatus = typeof PublicStatus.Type

export const PublicationTarget = Schema.Literals(["personal", "groups", "department", "company"])
export type PublicationTarget = typeof PublicationTarget.Type

export const GroupID = Schema.String.check(Schema.isPattern(/^grp_[a-zA-Z0-9_-]{8,64}$/)).annotate({
  identifier: "SkillMarketControl.GroupID",
})
export type GroupID = typeof GroupID.Type

const PersonalAudienceTarget = Schema.Struct({
  scope: Schema.Literal("personal"),
  department: Schema.Never.pipe(optional),
  groupIDs: Schema.Never.pipe(optional),
})
const CompanyAudienceTarget = Schema.Struct({
  scope: Schema.Literal("company"),
  department: Schema.Never.pipe(optional),
  groupIDs: Schema.Never.pipe(optional),
})
const DepartmentAudienceTarget = Schema.Struct({
  scope: Schema.Literal("department"),
  department: Department,
  groupIDs: Schema.Never.pipe(optional),
})
const GroupAudienceTarget = Schema.Struct({
  scope: Schema.Literal("groups"),
  department: Schema.Never.pipe(optional),
  groupIDs: Schema.Array(GroupID).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
})
export const AudienceTarget = Schema.Union([
  PersonalAudienceTarget,
  CompanyAudienceTarget,
  DepartmentAudienceTarget,
  GroupAudienceTarget,
]).annotate({ identifier: "SkillMarketControl.AudienceTarget" })
export type AudienceTarget = typeof AudienceTarget.Type

export interface MarketGroup extends Schema.Schema.Type<typeof MarketGroup> {}
export const MarketGroup = Schema.Struct({
  id: GroupID,
  name: bounded(1, 100),
  description: bounded(1, 500).pipe(optional),
  ownerEmployeeID: EmployeeID,
  status: Schema.Literals(["active", "disabled"]),
  version: Positive,
  createdAt: SkillMarket.Timestamp,
  updatedAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.MarketGroup" })

export interface MarketGroupMember extends Schema.Schema.Type<typeof MarketGroupMember> {}
export const MarketGroupMember = Schema.Struct({
  groupID: GroupID,
  employeeID: EmployeeID,
  createdByEmployeeID: EmployeeID,
  createdAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.MarketGroupMember" })

export interface GroupPage extends Schema.Schema.Type<typeof GroupPage> {}
export const GroupPage = Schema.Struct({
  managed: Schema.Array(MarketGroup),
  joined: Schema.Array(MarketGroup),
}).annotate({ identifier: "SkillMarketControl.GroupPage" })

export const GroupCreateInput = Schema.Struct({
  name: bounded(1, 100),
  description: bounded(1, 500).pipe(optional),
}).annotate({ identifier: "SkillMarketControl.GroupCreateInput" })
export type GroupCreateInput = typeof GroupCreateInput.Type

export const GroupUpdateInput = Schema.Struct({
  expectedVersion: Positive,
  name: bounded(1, 100).pipe(optional),
  description: Schema.NullOr(bounded(1, 500)).pipe(optional),
}).annotate({ identifier: "SkillMarketControl.GroupUpdateInput" })
export type GroupUpdateInput = typeof GroupUpdateInput.Type

export const GroupOwnerInput = Schema.Struct({
  expectedVersion: Positive,
  ownerEmployeeID: EmployeeID,
}).annotate({ identifier: "SkillMarketControl.GroupOwnerInput" })
export type GroupOwnerInput = typeof GroupOwnerInput.Type

export const GroupStatusInput = Schema.Struct({
  expectedVersion: Positive,
  status: MarketGroup.fields.status,
}).annotate({ identifier: "SkillMarketControl.GroupStatusInput" })
export type GroupStatusInput = typeof GroupStatusInput.Type

export const GroupMemberInput = Schema.Struct({
  expectedVersion: Positive,
  employeeID: EmployeeID,
}).annotate({ identifier: "SkillMarketControl.GroupMemberInput" })
export type GroupMemberInput = typeof GroupMemberInput.Type

export const GroupMemberRemoveInput = Schema.Struct({
  expectedVersion: Positive,
}).annotate({ identifier: "SkillMarketControl.GroupMemberRemoveInput" })
export type GroupMemberRemoveInput = typeof GroupMemberRemoveInput.Type

export interface User extends Schema.Schema.Type<typeof User> {}
export const User = Schema.Struct({
  employeeID: EmployeeID,
  displayName: bounded(1, 100),
  email: bounded(3, 254).pipe(optional),
  department: Department.pipe(optional),
  disabledAt: SkillMarket.Timestamp.pipe(optional),
}).annotate({ identifier: "SkillMarketControl.User" })

export interface Session extends Schema.Schema.Type<typeof Session> {}
export const Session = Schema.Struct({
  user: User,
  roles: Schema.Array(Role).check(Schema.isMaxLength(2)),
  csrfToken: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{43}$/)),
  createdAt: SkillMarket.Timestamp,
  absoluteExpiresAt: SkillMarket.Timestamp,
  idleExpiresAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.Session" })

export const SessionState = Schema.NullOr(Session).annotate({ identifier: "SkillMarketControl.SessionState" })
export type SessionState = typeof SessionState.Type

export interface SubmissionMetadata extends Schema.Schema.Type<typeof SubmissionMetadata> {}
export const SubmissionMetadata = Schema.Struct({
  version: SemVer,
  displayName: bounded(1, 120),
  description: bounded(1, 1_000),
  category: bounded(1, 80),
  tags: Schema.Array(bounded(1, 40)).check(Schema.isMaxLength(20)),
  license: bounded(1, 100).pipe(optional),
  requiresApiKey: Schema.Boolean,
  changeNotes: bounded(1, 2_000),
}).annotate({ identifier: "SkillMarketControl.SubmissionMetadata" })

export interface ManifestFile extends Schema.Schema.Type<typeof ManifestFile> {}
export const ManifestFile = Schema.Struct({
  path: bounded(1, 1_024),
  sha256: SkillMarket.Sha256,
  size: NonNegative,
  mime: bounded(1, 200),
}).annotate({ identifier: "SkillMarketControl.ManifestFile" })

export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}
export const Manifest = Schema.Struct({
  packageSha256: SkillMarket.Sha256,
  packageSize: NonNegative,
  files: Schema.Array(ManifestFile).check(Schema.isMaxLength(2_000)),
}).annotate({ identifier: "SkillMarketControl.Manifest" })

export interface ScanEvidence extends Schema.Schema.Type<typeof ScanEvidence> {}
export const ScanEvidence = Schema.Struct({
  rule: bounded(1, 120),
  summary: bounded(1, 500),
  path: bounded(1, 1_024).pipe(optional),
  line: Positive.pipe(optional),
}).annotate({ identifier: "SkillMarketControl.ScanEvidence" })

export interface ScanReport extends Schema.Schema.Type<typeof ScanReport> {}
export const ScanReport = Schema.Struct({
  risk: SkillMarket.Risk,
  reasons: Schema.Array(bounded(1, 500)).check(Schema.isMaxLength(100)),
  evidence: Schema.Array(ScanEvidence).check(Schema.isMaxLength(500)),
  scannedAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.ScanReport" })

export interface ValidationIssue extends Schema.Schema.Type<typeof ValidationIssue> {}
export const ValidationIssue = Schema.Struct({
  code: bounded(1, 120),
  message: bounded(1, 500),
  path: bounded(1, 1_024).pipe(optional),
}).annotate({ identifier: "SkillMarketControl.ValidationIssue" })

export interface Revision extends Schema.Schema.Type<typeof Revision> {}
export const Revision = Schema.Struct({
  number: Positive,
  metadata: SubmissionMetadata,
  manifest: Manifest.pipe(optional),
  scan: ScanReport.pipe(optional),
  validationIssues: Schema.Array(ValidationIssue).check(Schema.isMaxLength(500)),
  createdAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.Revision" })

export interface Review extends Schema.Schema.Type<typeof Review> {}
export const Review = Schema.Struct({
  revision: Positive,
  reviewer: User,
  decision: ReviewDecision,
  comment: bounded(1, 2_000).pipe(optional),
  acceptedRiskSummary: bounded(1, 2_000).pipe(optional),
  createdAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.Review" })

export interface StatusEvent extends Schema.Schema.Type<typeof StatusEvent> {}
export const StatusEvent = Schema.Struct({
  status: SubmissionStatus,
  at: SkillMarket.Timestamp,
  actor: User.pipe(optional),
  message: bounded(1, 2_000).pipe(optional),
}).annotate({ identifier: "SkillMarketControl.StatusEvent" })

export interface PublicSkill extends Schema.Schema.Type<typeof PublicSkill> {}
export const PublicSkill = Schema.Struct({
  source: Schema.Literal("community"),
  id: bounded(1, 128),
  version: SemVer,
  rowVersion: Positive,
  status: PublicStatus,
}).annotate({ identifier: "SkillMarketControl.PublicSkill" })

export interface SubmissionSummary extends Schema.Schema.Type<typeof SubmissionSummary> {}
export const SubmissionSummary = Schema.Struct({
  id: SubmissionID,
  skillID: bounded(1, 128),
  owner: User,
  targetVersion: SemVer,
  status: SubmissionStatus,
  currentRevision: Positive,
  version: Positive,
  risk: SkillMarket.Risk,
  target: AudienceTarget.pipe(optional),
  currentPublicVersion: SemVer.pipe(optional),
  createdAt: SkillMarket.Timestamp,
  updatedAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.SubmissionSummary" })

export interface SubmissionDetail extends Schema.Schema.Type<typeof SubmissionDetail> {}
export const SubmissionDetail = Schema.Struct({
  ...SubmissionSummary.fields,
  metadata: SubmissionMetadata,
  revisions: Schema.Array(Revision),
  reviews: Schema.Array(Review),
  timeline: Schema.Array(StatusEvent),
  publicSkill: PublicSkill.pipe(optional),
}).annotate({ identifier: "SkillMarketControl.SubmissionDetail" })

export interface SubmissionListQuery extends Schema.Schema.Type<typeof SubmissionListQuery> {}
export const SubmissionListQuery = Schema.Struct({
  status: SubmissionStatus.pipe(optional),
  target: PublicationTarget.pipe(optional),
  page: PageNumber,
  limit: PageLimit,
}).annotate({ identifier: "SkillMarketControl.SubmissionListQuery" })

export interface AdminSubmissionQuery extends Schema.Schema.Type<typeof AdminSubmissionQuery> {}
export const AdminSubmissionQuery = Schema.Struct({
  status: SubmissionStatus.pipe(optional),
  risk: SkillMarket.Risk.pipe(optional),
  submitter: EmployeeID.pipe(optional),
  createdFrom: SkillMarket.Timestamp.pipe(optional),
  createdTo: SkillMarket.Timestamp.pipe(optional),
  page: PageNumber,
  limit: PageLimit,
}).annotate({ identifier: "SkillMarketControl.AdminSubmissionQuery" })

export interface SubmissionPage extends Schema.Schema.Type<typeof SubmissionPage> {}
export const SubmissionPage = Schema.Struct({
  total: NonNegative,
  page: PageNumber,
  limit: PageLimit,
  items: Schema.Array(SubmissionSummary),
}).annotate({ identifier: "SkillMarketControl.SubmissionPage" })

export interface AcceptedSubmission extends Schema.Schema.Type<typeof AcceptedSubmission> {}
export const AcceptedSubmission = Schema.Struct({
  submission: SubmissionSummary,
}).annotate({ identifier: "SkillMarketControl.AcceptedSubmission" })

export interface RevisionInput extends Schema.Schema.Type<typeof RevisionInput> {}
export const RevisionInput = Schema.Struct({
  expectedVersion: Positive,
  metadata: SubmissionMetadata,
}).annotate({ identifier: "SkillMarketControl.RevisionInput" })

export interface SubmissionCreateInput extends Schema.Schema.Type<typeof SubmissionCreateInput> {}
export const SubmissionCreateInput = Schema.Struct({
  target: AudienceTarget,
  metadata: SubmissionMetadata,
}).annotate({ identifier: "SkillMarketControl.SubmissionCreateInput" })

export const PromotionInput = Schema.Struct({
  expectedVersion: Positive,
  target: Schema.Union([GroupAudienceTarget, DepartmentAudienceTarget, CompanyAudienceTarget]),
}).annotate({ identifier: "SkillMarketControl.PromotionInput" })
export type PromotionInput = typeof PromotionInput.Type

export const AudienceChangeInput = Schema.Struct({
  expectedVersion: Positive,
  target: AudienceTarget,
}).annotate({ identifier: "SkillMarketControl.AudienceChangeInput" })
export type AudienceChangeInput = typeof AudienceChangeInput.Type

export interface DecisionInput extends Schema.Schema.Type<typeof DecisionInput> {}
export const DecisionInput = Schema.Struct({
  expectedVersion: Positive,
  decision: ReviewDecision,
  comment: bounded(1, 2_000).pipe(optional),
  acceptedRiskSummary: bounded(1, 2_000).pipe(optional),
}).annotate({ identifier: "SkillMarketControl.DecisionInput" })

export interface ExpectedVersionInput extends Schema.Schema.Type<typeof ExpectedVersionInput> {}
export const ExpectedVersionInput = Schema.Struct({
  expectedVersion: Positive,
}).annotate({ identifier: "SkillMarketControl.ExpectedVersionInput" })

export interface ReasonInput extends Schema.Schema.Type<typeof ReasonInput> {}
export const ReasonInput = Schema.Struct({
  expectedVersion: Positive,
  reason: bounded(1, 2_000),
}).annotate({ identifier: "SkillMarketControl.ReasonInput" })

export interface RoleInput extends Schema.Schema.Type<typeof RoleInput> {}
export const RoleInput = Schema.Struct({
  employeeID: EmployeeID,
  role: Role,
}).annotate({ identifier: "SkillMarketControl.RoleInput" })

export interface RoleAssignment extends Schema.Schema.Type<typeof RoleAssignment> {}
export const RoleAssignment = Schema.Struct({
  user: User,
  role: Role,
  createdBy: EmployeeID,
  createdAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.RoleAssignment" })

export const SkillHubImportState = Schema.Literals(["idle", "running", "paused", "completed", "failed"])
export type SkillHubImportState = typeof SkillHubImportState.Type

export const SkillHubImportCommand = Schema.Literals(["pause", "resume", "retry-wait", "retry-rejected"])
export type SkillHubImportCommand = typeof SkillHubImportCommand.Type

const hasSQLiteSkillHubSlugLength = Schema.makeFilter<string>(
  (value) => {
    const firstNul = value.indexOf("\0")
    const firstNulOrEnd = firstNul === -1 ? value.length : firstNul
    const length = Array.from(value.slice(0, firstNulOrEnd)).length
    return length >= 1 && length <= 256
  },
  { expected: "a string whose SQLite TEXT length is between 1 and 256" },
)

export const SkillHubImportSlug = Schema.String.check(hasSQLiteSkillHubSlugLength)
export type SkillHubImportSlug = typeof SkillHubImportSlug.Type

const UntargetedSkillHubImportCommand = Schema.Struct({
  command: Schema.Literals(["pause", "resume", "retry-wait"]),
  slugs: Schema.Never.pipe(optional),
})
const RetryRejectedSkillHubImportCommand = Schema.Struct({
  command: Schema.Literal("retry-rejected"),
  slugs: Schema.Array(SkillHubImportSlug).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
})
export const SkillHubImportCommandInput = Schema.Union([
  UntargetedSkillHubImportCommand,
  RetryRejectedSkillHubImportCommand,
]).annotate({ identifier: "SkillMarketControl.SkillHubImportCommandInput" })
export type SkillHubImportCommandInput = typeof SkillHubImportCommandInput.Type

export const SkillHubImportErrorCode = Schema.Literals(["upstream", "download", "validation", "storage", "rate_limited"])
export type SkillHubImportErrorCode = typeof SkillHubImportErrorCode.Type

export const SkillHubImportError = Schema.Struct({
  code: SkillHubImportErrorCode,
  summary: bounded(1, 500),
  occurredAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.SkillHubImportError" })
export type SkillHubImportError = typeof SkillHubImportError.Type

export const SkillHubImportProgress = Schema.Struct({
  state: SkillHubImportState,
  sourceStatus: Schema.Literals(["fresh", "stale", "unavailable"]),
  upstreamTotal: NonNegative,
  discovered: NonNegative,
  pending: NonNegative,
  running: NonNegative,
  mirrored: NonNegative,
  retryWait: NonNegative,
  rejected: NonNegative,
  uploadedBytes: NonNegative,
  ratePerMinute: NonNegative,
  estimatedSecondsRemaining: NonNegative.pipe(optional),
  lastPublishedAt: SkillMarket.Timestamp.pipe(optional),
  recentError: SkillHubImportError.pipe(optional),
  discoveryPage: NonNegative,
  sweep: NonNegative,
  metadataConcurrency: Positive,
  packageConcurrency: Positive,
  updatedAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.SkillHubImportProgress" })
export type SkillHubImportProgress = typeof SkillHubImportProgress.Type

export const SkillHubEvaluationProgress = Schema.Struct({
  total: NonNegative,
  waiting: NonNegative,
  pending: NonNegative,
  running: NonNegative,
  retryWait: NonNegative,
  completed: NonNegative,
  failed: NonNegative,
  ratePerMinute: NonNegative,
  estimatedSecondsRemaining: NonNegative.pipe(optional),
  recentError: bounded(1, 500).pipe(optional),
}).annotate({ identifier: "SkillMarketControl.SkillHubEvaluationProgress" })
export type SkillHubEvaluationProgress = typeof SkillHubEvaluationProgress.Type

export const AnnouncementCreateInput = Schema.Struct({
  title: bounded(1, 120),
  summary: bounded(1, 300),
  content: bounded(1, 20_000),
}).annotate({ identifier: "SkillMarketControl.AnnouncementCreateInput" })
export type AnnouncementCreateInput = typeof AnnouncementCreateInput.Type

export const AuditAction = Schema.Literals([
  "bootstrap-admin",
  "role-assigned",
  "role-removed",
  "submission-created",
  "revision-uploaded",
  "validation-succeeded",
  "validation-failed",
  "review-approved",
  "review-changes-requested",
  "review-rejected",
  "publish-started",
  "publish-succeeded",
  "publish-failed",
  "publish-retried",
  "community-delisted",
  "community-restored",
  "user-disabled",
  "user-enabled",
  "skillhub-import-paused",
  "skillhub-import-resumed",
  "skillhub-import-retried",
  "announcement-published",
])
export type AuditAction = typeof AuditAction.Type

export const AuditObjectType = Schema.Literals([
  "user",
  "role",
  "submission",
  "revision",
  "publish_job",
  "community_skill",
  "skillhub_import",
  "announcement",
])
export type AuditObjectType = typeof AuditObjectType.Type

export interface AuditEvent extends Schema.Schema.Type<typeof AuditEvent> {}
export const AuditEvent = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^aud_[a-zA-Z0-9_-]{8,64}$/)),
  actor: User.pipe(optional),
  action: AuditAction,
  objectType: AuditObjectType,
  objectID: bounded(1, 128),
  before: Schema.Record(Schema.String, Schema.Json).pipe(optional),
  after: Schema.Record(Schema.String, Schema.Json).pipe(optional),
  requestID: RequestID,
  createdAt: SkillMarket.Timestamp,
}).annotate({ identifier: "SkillMarketControl.AuditEvent" })

export interface AuditQuery extends Schema.Schema.Type<typeof AuditQuery> {}
export const AuditQuery = Schema.Struct({
  actor: EmployeeID.pipe(optional),
  action: AuditAction.pipe(optional),
  objectType: AuditObjectType.pipe(optional),
  objectID: bounded(1, 128).pipe(optional),
  createdFrom: SkillMarket.Timestamp.pipe(optional),
  createdTo: SkillMarket.Timestamp.pipe(optional),
  page: PageNumber,
  limit: PageLimit,
}).annotate({ identifier: "SkillMarketControl.AuditQuery" })

export interface AuditPage extends Schema.Schema.Type<typeof AuditPage> {}
export const AuditPage = Schema.Struct({
  total: NonNegative,
  page: PageNumber,
  limit: PageLimit,
  items: Schema.Array(AuditEvent),
}).annotate({ identifier: "SkillMarketControl.AuditPage" })

export const ProblemCode = Schema.Literals([
  "unauthenticated",
  "forbidden",
  "csrf-invalid",
  "not-found",
  "invalid-request",
  "submission-conflict",
  "skill-owned-by-another-user",
  "last-admin",
  "upload-too-large",
  "validation-failed",
  "upload-rate-limited",
  "dependency-unavailable",
])
export type ProblemCode = typeof ProblemCode.Type

export interface Problem extends Schema.Schema.Type<typeof Problem> {}
export const Problem = Schema.Struct({
  code: ProblemCode,
  message: bounded(1, 500),
  requestId: RequestID,
}).annotate({ identifier: "SkillMarketControl.Problem" })
