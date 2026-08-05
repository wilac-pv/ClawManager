export type SkillMarketControlNotFound = {
  readonly code: "not-found"
  readonly message: string
  readonly requestId: string
}
export const isSkillMarketControlNotFound = (value: unknown): value is SkillMarketControlNotFound =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "not-found"

export type SkillMarketDependencyUnavailable = {
  readonly code: "dependency-unavailable"
  readonly message: string
  readonly requestId: string
}
export const isSkillMarketDependencyUnavailable = (value: unknown): value is SkillMarketDependencyUnavailable =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "dependency-unavailable"

export type SkillMarketInvalidRequest = {
  readonly code: "invalid-request"
  readonly message: string
  readonly requestId: string
}
export const isSkillMarketInvalidRequest = (value: unknown): value is SkillMarketInvalidRequest =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "invalid-request"

export type SkillMarketCsrfInvalid = {
  readonly code: "csrf-invalid"
  readonly message: string
  readonly requestId: string
}
export const isSkillMarketCsrfInvalid = (value: unknown): value is SkillMarketCsrfInvalid =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "csrf-invalid"

export type SkillMarketForbidden = { readonly code: "forbidden"; readonly message: string; readonly requestId: string }
export const isSkillMarketForbidden = (value: unknown): value is SkillMarketForbidden =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "forbidden"

export type SkillMarketUnauthenticated = {
  readonly code: "unauthenticated"
  readonly message: string
  readonly requestId: string
}
export const isSkillMarketUnauthenticated = (value: unknown): value is SkillMarketUnauthenticated =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "unauthenticated"

export type SkillMarketSubmissionConflict = {
  readonly code: "submission-conflict"
  readonly message: string
  readonly requestId: string
}
export const isSkillMarketSubmissionConflict = (value: unknown): value is SkillMarketSubmissionConflict =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "submission-conflict"

export type SkillMarketOwnershipConflict = {
  readonly code: "skill-owned-by-another-user"
  readonly message: string
  readonly requestId: string
}
export const isSkillMarketOwnershipConflict = (value: unknown): value is SkillMarketOwnershipConflict =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "skill-owned-by-another-user"

export type SkillMarketUploadTooLarge = {
  readonly code: "upload-too-large"
  readonly message: string
  readonly requestId: string
}
export const isSkillMarketUploadTooLarge = (value: unknown): value is SkillMarketUploadTooLarge =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "upload-too-large"

export type SkillMarketValidationFailed = {
  readonly code: "validation-failed"
  readonly message: string
  readonly requestId: string
}
export const isSkillMarketValidationFailed = (value: unknown): value is SkillMarketValidationFailed =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "validation-failed"

export type SkillMarketUploadRateLimited = {
  readonly code: "upload-rate-limited"
  readonly message: string
  readonly requestId: string
}
export const isSkillMarketUploadRateLimited = (value: unknown): value is SkillMarketUploadRateLimited =>
  typeof value === "object" && value !== null && "code" in value && value["code"] === "upload-rate-limited"

export type SkillMarketRestrictedRestrictedDetailInput = {
  readonly publicationID: { readonly publicationID: string }["publicationID"]
}

export type SkillMarketRestrictedRestrictedDetailOutput = {
  readonly id: string
  readonly source: "restricted"
  readonly sourceUrl: string
  readonly name: string
  readonly description: string
  readonly iconUrl?: string
  readonly categories: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly aliases?: ReadonlyArray<string>
  readonly requiresApiKey: boolean
  readonly risk: "unknown" | "safe" | "warning" | "danger"
  readonly version: string
  readonly updatedAt: string
  readonly downloads: number | "Infinity" | "-Infinity" | "NaN"
  readonly favorites: number | "Infinity" | "-Infinity" | "NaN"
  readonly score: number | "Infinity" | "-Infinity" | "NaN"
  readonly evaluationScore?: number
  readonly traceEvaluation?: {
    readonly trust: number
    readonly reliability: number
    readonly adaptability: number
    readonly convention: number
    readonly effectiveness: number
    readonly evaluatedAt: string
  }
  readonly featured: boolean
  readonly enterprise: boolean
  readonly visibility?: "personal" | "groups" | "department"
  readonly delisted: boolean
  readonly installedVersion?: string
  readonly updateAvailable?: boolean
  readonly submittedBy?: { readonly displayName: string }
  readonly reviewedAt?: string
  readonly reviewRisk?: "unknown" | "safe" | "warning" | "danger"
  readonly readme: string
  readonly license?: string
  readonly author: { readonly name: string; readonly url?: string }
  readonly versions: ReadonlyArray<{
    readonly version: string
    readonly publishedAt: string
    readonly sha256: string
    readonly size: number | "Infinity" | "-Infinity" | "NaN"
  }>
  readonly securityReports: ReadonlyArray<{
    readonly provider: string
    readonly verdict: "unknown" | "safe" | "warning" | "danger"
    readonly summary: string
    readonly reportUrl?: string
  }>
  readonly riskReason?: string
  readonly package: {
    readonly url: string
    readonly sha256: string
    readonly size: number | "Infinity" | "-Infinity" | "NaN"
    readonly files: ReadonlyArray<{
      readonly path: string
      readonly sha256: string
      readonly size: number | "Infinity" | "-Infinity" | "NaN"
    }>
  }
  readonly publicDetailUrl: string
}

export type SkillMarketRestrictedRestrictedVersionsInput = {
  readonly publicationID: { readonly publicationID: string }["publicationID"]
}

export type SkillMarketRestrictedRestrictedVersionsOutput = ReadonlyArray<{
  readonly version: string
  readonly publishedAt: string
  readonly sha256: string
  readonly size: number
}>

export type SkillMarketRestrictedPrivateInstallGrantInput = {
  readonly publicationID: { readonly publicationID: string }["publicationID"]
}

export type SkillMarketRestrictedPrivateInstallGrantOutput = { readonly url: string; readonly expiresAt: string }

export type SkillMarketGroupsListOutput = {
  readonly managed: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly ownerEmployeeID: string
    readonly status: "active" | "disabled"
    readonly version: number
    readonly createdAt: string
    readonly updatedAt: string
  }>
  readonly joined: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly ownerEmployeeID: string
    readonly status: "active" | "disabled"
    readonly version: number
    readonly createdAt: string
    readonly updatedAt: string
  }>
}

export type SkillMarketGroupsCreateInput = {
  readonly name: { readonly name: string; readonly description?: string }["name"]
  readonly description?: { readonly name: string; readonly description?: string }["description"]
}

export type SkillMarketGroupsCreateOutput = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly ownerEmployeeID: string
  readonly status: "active" | "disabled"
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type SkillMarketGroupsDetailInput = { readonly groupID: { readonly groupID: string }["groupID"] }

export type SkillMarketGroupsDetailOutput = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly ownerEmployeeID: string
  readonly status: "active" | "disabled"
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type SkillMarketGroupsUpdateInput = {
  readonly groupID: { readonly groupID: string }["groupID"]
  readonly expectedVersion: {
    readonly expectedVersion: number
    readonly name?: string
    readonly description?: string | null
  }["expectedVersion"]
  readonly name?: {
    readonly expectedVersion: number
    readonly name?: string
    readonly description?: string | null
  }["name"]
  readonly description?: {
    readonly expectedVersion: number
    readonly name?: string
    readonly description?: string | null
  }["description"]
}

export type SkillMarketGroupsUpdateOutput = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly ownerEmployeeID: string
  readonly status: "active" | "disabled"
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type SkillMarketGroupsTransferInput = {
  readonly groupID: { readonly groupID: string }["groupID"]
  readonly expectedVersion: { readonly expectedVersion: number; readonly ownerEmployeeID: string }["expectedVersion"]
  readonly ownerEmployeeID: { readonly expectedVersion: number; readonly ownerEmployeeID: string }["ownerEmployeeID"]
}

export type SkillMarketGroupsTransferOutput = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly ownerEmployeeID: string
  readonly status: "active" | "disabled"
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type SkillMarketGroupsSetStatusInput = {
  readonly groupID: { readonly groupID: string }["groupID"]
  readonly expectedVersion: {
    readonly expectedVersion: number
    readonly status: "active" | "disabled"
  }["expectedVersion"]
  readonly status: { readonly expectedVersion: number; readonly status: "active" | "disabled" }["status"]
}

export type SkillMarketGroupsSetStatusOutput = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly ownerEmployeeID: string
  readonly status: "active" | "disabled"
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type SkillMarketGroupsMembersInput = { readonly groupID: { readonly groupID: string }["groupID"] }

export type SkillMarketGroupsMembersOutput = ReadonlyArray<{
  readonly groupID: string
  readonly employeeID: string
  readonly createdByEmployeeID: string
  readonly createdAt: string
}>

export type SkillMarketGroupsAddMemberInput = {
  readonly groupID: { readonly groupID: string }["groupID"]
  readonly expectedVersion: { readonly expectedVersion: number; readonly employeeID: string }["expectedVersion"]
  readonly employeeID: { readonly expectedVersion: number; readonly employeeID: string }["employeeID"]
}

export type SkillMarketGroupsAddMemberOutput = {
  readonly groupID: string
  readonly employeeID: string
  readonly createdByEmployeeID: string
  readonly createdAt: string
}

export type SkillMarketGroupsRemoveMemberInput = {
  readonly groupID: { readonly groupID: string; readonly employeeID: string }["groupID"]
  readonly employeeID: { readonly groupID: string; readonly employeeID: string }["employeeID"]
  readonly expectedVersion: { readonly expectedVersion: number }["expectedVersion"]
}

export type SkillMarketGroupsRemoveMemberOutput = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly ownerEmployeeID: string
  readonly status: "active" | "disabled"
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

export type SkillMarketSharingPromoteInput = {
  readonly submissionID: { readonly submissionID: string }["submissionID"]
  readonly expectedVersion: {
    readonly expectedVersion: number
    readonly target: "groups" | "department" | "company"
    readonly audience?:
      | { readonly scope: "department"; readonly department?: never; readonly groupIDs?: never }
      | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
  }["expectedVersion"]
  readonly target: {
    readonly expectedVersion: number
    readonly target: "groups" | "department" | "company"
    readonly audience?:
      | { readonly scope: "department"; readonly department?: never; readonly groupIDs?: never }
      | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
  }["target"]
  readonly audience?: {
    readonly expectedVersion: number
    readonly target: "groups" | "department" | "company"
    readonly audience?:
      | { readonly scope: "department"; readonly department?: never; readonly groupIDs?: never }
      | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
  }["audience"]
}

export type SkillMarketSharingPromoteOutput = {
  readonly submission: {
    readonly id: string
    readonly skillID: string
    readonly owner: {
      readonly employeeID: string
      readonly displayName: string
      readonly email?: string
      readonly department?: { readonly id: string; readonly name: string }
      readonly disabledAt?: string
    }
    readonly targetVersion: string
    readonly status:
      | "validating"
      | "validation_failed"
      | "pending_review"
      | "changes_requested"
      | "rejected"
      | "publishing"
      | "publish_failed"
      | "published"
      | "withdrawn"
    readonly currentRevision: number
    readonly version: number
    readonly risk: "unknown" | "safe" | "warning" | "danger"
    readonly target?: "personal" | "groups" | "department" | "company"
    readonly audience?:
      | { readonly scope: "personal"; readonly department?: never; readonly groupIDs?: never }
      | { readonly scope: "company"; readonly department?: never; readonly groupIDs?: never }
      | {
          readonly scope: "department"
          readonly department: { readonly id: string; readonly name: string }
          readonly groupIDs?: never
        }
      | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
    readonly currentPublicVersion?: string
    readonly createdAt: string
    readonly updatedAt: string
  }
}

export type SkillMarketSharingAudienceChangeInput = {
  readonly submissionID: { readonly submissionID: string }["submissionID"]
  readonly expectedVersion: {
    readonly expectedVersion: number
    readonly target: "personal" | "groups" | "department" | "company"
    readonly audience?:
      | { readonly scope: "department"; readonly department?: never; readonly groupIDs?: never }
      | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
  }["expectedVersion"]
  readonly target: {
    readonly expectedVersion: number
    readonly target: "personal" | "groups" | "department" | "company"
    readonly audience?:
      | { readonly scope: "department"; readonly department?: never; readonly groupIDs?: never }
      | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
  }["target"]
  readonly audience?: {
    readonly expectedVersion: number
    readonly target: "personal" | "groups" | "department" | "company"
    readonly audience?:
      | { readonly scope: "department"; readonly department?: never; readonly groupIDs?: never }
      | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
  }["audience"]
}

export type SkillMarketSharingAudienceChangeOutput = {
  readonly submission: {
    readonly id: string
    readonly skillID: string
    readonly owner: {
      readonly employeeID: string
      readonly displayName: string
      readonly email?: string
      readonly department?: { readonly id: string; readonly name: string }
      readonly disabledAt?: string
    }
    readonly targetVersion: string
    readonly status:
      | "validating"
      | "validation_failed"
      | "pending_review"
      | "changes_requested"
      | "rejected"
      | "publishing"
      | "publish_failed"
      | "published"
      | "withdrawn"
    readonly currentRevision: number
    readonly version: number
    readonly risk: "unknown" | "safe" | "warning" | "danger"
    readonly target?: "personal" | "groups" | "department" | "company"
    readonly audience?:
      | { readonly scope: "personal"; readonly department?: never; readonly groupIDs?: never }
      | { readonly scope: "company"; readonly department?: never; readonly groupIDs?: never }
      | {
          readonly scope: "department"
          readonly department: { readonly id: string; readonly name: string }
          readonly groupIDs?: never
        }
      | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
    readonly currentPublicVersion?: string
    readonly createdAt: string
    readonly updatedAt: string
  }
}

export type SkillMarketSubmissionLifecyclePersonalTrashOutput = ReadonlyArray<{
  readonly id: string
  readonly skillID: string
  readonly owner: {
    readonly employeeID: string
    readonly displayName: string
    readonly email?: string
    readonly department?: { readonly id: string; readonly name: string }
    readonly disabledAt?: string
  }
  readonly targetVersion: string
  readonly status:
    | "validating"
    | "validation_failed"
    | "pending_review"
    | "changes_requested"
    | "rejected"
    | "publishing"
    | "publish_failed"
    | "published"
    | "withdrawn"
  readonly currentRevision: number
  readonly version: number
  readonly risk: "unknown" | "safe" | "warning" | "danger"
  readonly target?: "personal" | "groups" | "department" | "company"
  readonly audience?:
    | { readonly scope: "personal"; readonly department?: never; readonly groupIDs?: never }
    | { readonly scope: "company"; readonly department?: never; readonly groupIDs?: never }
    | {
        readonly scope: "department"
        readonly department: { readonly id: string; readonly name: string }
        readonly groupIDs?: never
      }
    | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
  readonly currentPublicVersion?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string
  readonly purgeAfter: string
}>

export type SkillMarketSubmissionLifecyclePersonalDeleteInput = {
  readonly submissionID: { readonly submissionID: string }["submissionID"]
  readonly expectedVersion: { readonly expectedVersion: number }["expectedVersion"]
}

export type SkillMarketSubmissionLifecyclePersonalDeleteOutput = {
  readonly id: string
  readonly skillID: string
  readonly owner: {
    readonly employeeID: string
    readonly displayName: string
    readonly email?: string
    readonly department?: { readonly id: string; readonly name: string }
    readonly disabledAt?: string
  }
  readonly targetVersion: string
  readonly status:
    | "validating"
    | "validation_failed"
    | "pending_review"
    | "changes_requested"
    | "rejected"
    | "publishing"
    | "publish_failed"
    | "published"
    | "withdrawn"
  readonly currentRevision: number
  readonly version: number
  readonly risk: "unknown" | "safe" | "warning" | "danger"
  readonly target?: "personal" | "groups" | "department" | "company"
  readonly audience?:
    | { readonly scope: "personal"; readonly department?: never; readonly groupIDs?: never }
    | { readonly scope: "company"; readonly department?: never; readonly groupIDs?: never }
    | {
        readonly scope: "department"
        readonly department: { readonly id: string; readonly name: string }
        readonly groupIDs?: never
      }
    | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
  readonly currentPublicVersion?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string
  readonly purgeAfter: string
}

export type SkillMarketSubmissionLifecyclePersonalRestoreInput = {
  readonly submissionID: { readonly submissionID: string }["submissionID"]
  readonly expectedVersion: { readonly expectedVersion: number }["expectedVersion"]
}

export type SkillMarketSubmissionLifecyclePersonalRestoreOutput = {
  readonly id: string
  readonly skillID: string
  readonly owner: {
    readonly employeeID: string
    readonly displayName: string
    readonly email?: string
    readonly department?: { readonly id: string; readonly name: string }
    readonly disabledAt?: string
  }
  readonly targetVersion: string
  readonly status:
    | "validating"
    | "validation_failed"
    | "pending_review"
    | "changes_requested"
    | "rejected"
    | "publishing"
    | "publish_failed"
    | "published"
    | "withdrawn"
  readonly currentRevision: number
  readonly version: number
  readonly risk: "unknown" | "safe" | "warning" | "danger"
  readonly target?: "personal" | "groups" | "department" | "company"
  readonly audience?:
    | { readonly scope: "personal"; readonly department?: never; readonly groupIDs?: never }
    | { readonly scope: "company"; readonly department?: never; readonly groupIDs?: never }
    | {
        readonly scope: "department"
        readonly department: { readonly id: string; readonly name: string }
        readonly groupIDs?: never
      }
    | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
  readonly currentPublicVersion?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type SkillMarketSubmissionLifecycleWithdrawInput = {
  readonly submissionID: { readonly submissionID: string }["submissionID"]
  readonly expectedVersion: { readonly expectedVersion: number }["expectedVersion"]
}

export type SkillMarketSubmissionLifecycleWithdrawOutput = {
  readonly id: string
  readonly skillID: string
  readonly owner: {
    readonly employeeID: string
    readonly displayName: string
    readonly email?: string
    readonly department?: { readonly id: string; readonly name: string }
    readonly disabledAt?: string
  }
  readonly targetVersion: string
  readonly status:
    | "validating"
    | "validation_failed"
    | "pending_review"
    | "changes_requested"
    | "rejected"
    | "publishing"
    | "publish_failed"
    | "published"
    | "withdrawn"
  readonly currentRevision: number
  readonly version: number
  readonly risk: "unknown" | "safe" | "warning" | "danger"
  readonly target?: "personal" | "groups" | "department" | "company"
  readonly audience?:
    | { readonly scope: "personal"; readonly department?: never; readonly groupIDs?: never }
    | { readonly scope: "company"; readonly department?: never; readonly groupIDs?: never }
    | {
        readonly scope: "department"
        readonly department: { readonly id: string; readonly name: string }
        readonly groupIDs?: never
      }
    | { readonly scope: "groups"; readonly department?: never; readonly groupIDs: ReadonlyArray<string> }
  readonly currentPublicVersion?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly metadata: {
    readonly version: string
    readonly displayName: string
    readonly description: string
    readonly category: string
    readonly tags: ReadonlyArray<string>
    readonly license?: string
    readonly requiresApiKey: boolean
    readonly changeNotes: string
  }
  readonly revisions: ReadonlyArray<{
    readonly number: number
    readonly metadata: {
      readonly version: string
      readonly displayName: string
      readonly description: string
      readonly category: string
      readonly tags: ReadonlyArray<string>
      readonly license?: string
      readonly requiresApiKey: boolean
      readonly changeNotes: string
    }
    readonly manifest?: {
      readonly packageSha256: string
      readonly packageSize: number
      readonly files: ReadonlyArray<{
        readonly path: string
        readonly sha256: string
        readonly size: number
        readonly mime: string
      }>
    }
    readonly scan?: {
      readonly risk: "unknown" | "safe" | "warning" | "danger"
      readonly reasons: ReadonlyArray<string>
      readonly evidence: ReadonlyArray<{
        readonly rule: string
        readonly summary: string
        readonly path?: string
        readonly line?: number
      }>
      readonly scannedAt: string
    }
    readonly validationIssues: ReadonlyArray<{
      readonly code: string
      readonly message: string
      readonly path?: string
    }>
    readonly createdAt: string
  }>
  readonly reviews: ReadonlyArray<{
    readonly revision: number
    readonly reviewer: {
      readonly employeeID: string
      readonly displayName: string
      readonly email?: string
      readonly department?: { readonly id: string; readonly name: string }
      readonly disabledAt?: string
    }
    readonly decision: "approve" | "request_changes" | "reject"
    readonly comment?: string
    readonly acceptedRiskSummary?: string
    readonly createdAt: string
  }>
  readonly timeline: ReadonlyArray<{
    readonly status:
      | "validating"
      | "validation_failed"
      | "pending_review"
      | "changes_requested"
      | "rejected"
      | "publishing"
      | "publish_failed"
      | "published"
      | "withdrawn"
    readonly at: string
    readonly actor?: {
      readonly employeeID: string
      readonly displayName: string
      readonly email?: string
      readonly department?: { readonly id: string; readonly name: string }
      readonly disabledAt?: string
    }
    readonly message?: string
  }>
  readonly publicSkill?: {
    readonly source: "community"
    readonly id: string
    readonly version: string
    readonly rowVersion: number
    readonly status: "published" | "delisted"
  }
}

export type SkillMarketSubmissionLifecycleRequestDelistInput = {
  readonly submissionID: { readonly submissionID: string }["submissionID"]
  readonly expectedVersion: { readonly expectedVersion: number; readonly reason: string }["expectedVersion"]
  readonly reason: { readonly expectedVersion: number; readonly reason: string }["reason"]
}

export type SkillMarketSubmissionLifecycleRequestDelistOutput =
  | {
      readonly id: string
      readonly submissionID: string
      readonly requestedByEmployeeID: string
      readonly reason: string
      readonly version: number
      readonly createdAt: string
      readonly status: "pending"
      readonly decidedByEmployeeID?: never
      readonly decidedAt?: never
    }
  | {
      readonly id: string
      readonly submissionID: string
      readonly requestedByEmployeeID: string
      readonly reason: string
      readonly version: number
      readonly createdAt: string
      readonly status: "approved" | "rejected"
      readonly decidedByEmployeeID: string
      readonly decidedAt: string
    }

export type SkillMarketAdminLifecycleApproveDelistInput = {
  readonly requestID: { readonly requestID: string }["requestID"]
  readonly expectedVersion: { readonly expectedVersion: number }["expectedVersion"]
}

export type SkillMarketAdminLifecycleApproveDelistOutput =
  | {
      readonly id: string
      readonly submissionID: string
      readonly requestedByEmployeeID: string
      readonly reason: string
      readonly version: number
      readonly createdAt: string
      readonly status: "pending"
      readonly decidedByEmployeeID?: never
      readonly decidedAt?: never
    }
  | {
      readonly id: string
      readonly submissionID: string
      readonly requestedByEmployeeID: string
      readonly reason: string
      readonly version: number
      readonly createdAt: string
      readonly status: "approved" | "rejected"
      readonly decidedByEmployeeID: string
      readonly decidedAt: string
    }

export type SkillMarketAdminLifecycleRejectDelistInput = {
  readonly requestID: { readonly requestID: string }["requestID"]
  readonly expectedVersion: { readonly expectedVersion: number }["expectedVersion"]
}

export type SkillMarketAdminLifecycleRejectDelistOutput =
  | {
      readonly id: string
      readonly submissionID: string
      readonly requestedByEmployeeID: string
      readonly reason: string
      readonly version: number
      readonly createdAt: string
      readonly status: "pending"
      readonly decidedByEmployeeID?: never
      readonly decidedAt?: never
    }
  | {
      readonly id: string
      readonly submissionID: string
      readonly requestedByEmployeeID: string
      readonly reason: string
      readonly version: number
      readonly createdAt: string
      readonly status: "approved" | "rejected"
      readonly decidedByEmployeeID: string
      readonly decidedAt: string
    }
