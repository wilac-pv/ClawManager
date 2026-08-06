import type {
  SkillMarketRestrictedRestrictedDetailInput,
  SkillMarketRestrictedRestrictedDetailOutput,
  SkillMarketRestrictedRestrictedVersionsInput,
  SkillMarketRestrictedRestrictedVersionsOutput,
  SkillMarketRestrictedPrivateInstallGrantInput,
  SkillMarketRestrictedPrivateInstallGrantOutput,
  SkillMarketGroupsListOutput,
  SkillMarketGroupsCreateInput,
  SkillMarketGroupsCreateOutput,
  SkillMarketGroupsDetailInput,
  SkillMarketGroupsDetailOutput,
  SkillMarketGroupsUpdateInput,
  SkillMarketGroupsUpdateOutput,
  SkillMarketGroupsTransferInput,
  SkillMarketGroupsTransferOutput,
  SkillMarketGroupsSetStatusInput,
  SkillMarketGroupsSetStatusOutput,
  SkillMarketGroupsMembersInput,
  SkillMarketGroupsMembersOutput,
  SkillMarketGroupsAddMemberInput,
  SkillMarketGroupsAddMemberOutput,
  SkillMarketGroupsRemoveMemberInput,
  SkillMarketGroupsRemoveMemberOutput,
  SkillMarketSharingPromoteInput,
  SkillMarketSharingPromoteOutput,
  SkillMarketSharingAudienceChangeInput,
  SkillMarketSharingAudienceChangeOutput,
  SkillMarketSubmissionLifecyclePersonalTrashOutput,
  SkillMarketSubmissionLifecyclePersonalDeleteInput,
  SkillMarketSubmissionLifecyclePersonalDeleteOutput,
  SkillMarketSubmissionLifecyclePersonalRestoreInput,
  SkillMarketSubmissionLifecyclePersonalRestoreOutput,
  SkillMarketSubmissionLifecycleWithdrawInput,
  SkillMarketSubmissionLifecycleWithdrawOutput,
  SkillMarketSubmissionLifecycleRequestDelistInput,
  SkillMarketSubmissionLifecycleRequestDelistOutput,
  SkillMarketSubmissionLifecyclePendingDelistInput,
  SkillMarketSubmissionLifecyclePendingDelistOutput,
  SkillMarketAdminLifecyclePendingDelistInput,
  SkillMarketAdminLifecyclePendingDelistOutput,
  SkillMarketAdminLifecycleListDelistInput,
  SkillMarketAdminLifecycleListDelistOutput,
  SkillMarketAdminLifecycleApproveDelistInput,
  SkillMarketAdminLifecycleApproveDelistOutput,
  SkillMarketAdminLifecycleRejectDelistInput,
  SkillMarketAdminLifecycleRejectDelistOutput,
} from "./types"
import { ClientError } from "./client-error"

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: HeadersInit
}

export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly headers?: HeadersInit
}

interface RequestDescriptor {
  readonly method: string
  readonly path: string
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, unknown>
  readonly body?: unknown
  readonly successStatus: number
  readonly declaredStatuses: ReadonlyArray<number>
  readonly empty: boolean
}

export function make(options: ClientOptions) {
  const fetch = options.fetch ?? globalThis.fetch

  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    const url = new URL(descriptor.path, options.baseUrl)
    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)
    const headers = new Headers(options.headers)
    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {
      if (value !== undefined && value !== null) headers.set(key, String(value))
    }
    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)
    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    return {
      url,
      init: {
        method: descriptor.method,
        signal: requestOptions?.signal,
        headers,
        body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),
      } satisfies RequestInit,
    }
  }

  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    try {
      const prepared = prepare(descriptor, requestOptions)
      return await fetch(prepared.url, prepared.init)
    } catch (cause) {
      throw new ClientError("Transport", { cause })
    }
  }

  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {
    if (descriptor.declaredStatuses.includes(response.status)) throw await json(response)
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
  }

  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {
    const response = await execute(descriptor, requestOptions)
    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)
    if (descriptor.empty) {
      try {
        await response.body?.cancel()
      } catch {}
      return undefined as A
    }
    return (await json(response)) as A
  }

  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> => ({
    async *[Symbol.asyncIterator]() {
      const response = await execute(descriptor, requestOptions)
      if (response.status !== descriptor.successStatus) await responseError(response, descriptor)
      if (!isContentType(response, "text/event-stream")) {
        try {
          await response.body?.cancel()
        } catch {}
        throw new ClientError("UnsupportedContentType")
      }
      if (response.body === null) throw new ClientError("MalformedResponse")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          let next
          try {
            next = await reader.read()
          } catch (cause) {
            throw new ClientError("Transport", { cause })
          }
          buffer += decoder.decode(next.value, { stream: !next.done })
          if (buffer.length > 1_048_576) throw new ClientError("MalformedResponse")
          const trailingCarriageReturn = !next.done && buffer.endsWith("\r")
          if (trailingCarriageReturn) buffer = buffer.slice(0, -1)
          buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
          if (trailingCarriageReturn) buffer += "\r"
          if (next.done && buffer !== "") buffer += "\n\n"
          let boundary = buffer.indexOf("\n\n")
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = block
              .split("\n")
              .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
              .join("\n")
            if (data !== "") {
              try {
                yield JSON.parse(data) as A
              } catch (cause) {
                throw new ClientError("MalformedResponse", { cause })
              }
            }
            boundary = buffer.indexOf("\n\n")
          }
          if (next.done) return
        }
      } finally {
        try {
          await reader.cancel()
        } catch {}
        reader.releaseLock()
      }
    },
  })

  return {
    skillMarketRestricted: {
      restrictedDetail: (input: SkillMarketRestrictedRestrictedDetailInput, requestOptions?: RequestOptions) =>
        request<SkillMarketRestrictedRestrictedDetailOutput>(
          {
            method: "GET",
            path: `/v1/restricted-skills/${encodeURIComponent(input.publicationID)}`,
            successStatus: 200,
            declaredStatuses: [404, 503],
            empty: false,
          },
          requestOptions,
        ),
      restrictedVersions: (input: SkillMarketRestrictedRestrictedVersionsInput, requestOptions?: RequestOptions) =>
        request<SkillMarketRestrictedRestrictedVersionsOutput>(
          {
            method: "GET",
            path: `/v1/restricted-skills/${encodeURIComponent(input.publicationID)}/versions`,
            successStatus: 200,
            declaredStatuses: [404, 503],
            empty: false,
          },
          requestOptions,
        ),
      privateInstallGrant: (input: SkillMarketRestrictedPrivateInstallGrantInput, requestOptions?: RequestOptions) =>
        request<SkillMarketRestrictedPrivateInstallGrantOutput>(
          {
            method: "POST",
            path: `/v1/restricted-skills/${encodeURIComponent(input.publicationID)}/install-grants`,
            successStatus: 200,
            declaredStatuses: [404, 400, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    skillMarketGroups: {
      list: (requestOptions?: RequestOptions) =>
        request<SkillMarketGroupsListOutput>(
          { method: "GET", path: `/v1/groups`, successStatus: 200, declaredStatuses: [503, 401], empty: false },
          requestOptions,
        ),
      create: (input: SkillMarketGroupsCreateInput, requestOptions?: RequestOptions) =>
        request<SkillMarketGroupsCreateOutput>(
          {
            method: "POST",
            path: `/v1/groups`,
            body: { name: input["name"], description: input["description"] },
            successStatus: 200,
            declaredStatuses: [400, 409, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      detail: (input: SkillMarketGroupsDetailInput, requestOptions?: RequestOptions) =>
        request<SkillMarketGroupsDetailOutput>(
          {
            method: "GET",
            path: `/v1/groups/${encodeURIComponent(input.groupID)}`,
            successStatus: 200,
            declaredStatuses: [404, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: SkillMarketGroupsUpdateInput, requestOptions?: RequestOptions) =>
        request<SkillMarketGroupsUpdateOutput>(
          {
            method: "PATCH",
            path: `/v1/groups/${encodeURIComponent(input.groupID)}`,
            body: { expectedVersion: input["expectedVersion"], name: input["name"], description: input["description"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      transfer: (input: SkillMarketGroupsTransferInput, requestOptions?: RequestOptions) =>
        request<SkillMarketGroupsTransferOutput>(
          {
            method: "POST",
            path: `/v1/groups/${encodeURIComponent(input.groupID)}/ownership`,
            body: { expectedVersion: input["expectedVersion"], ownerEmployeeID: input["ownerEmployeeID"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      setStatus: (input: SkillMarketGroupsSetStatusInput, requestOptions?: RequestOptions) =>
        request<SkillMarketGroupsSetStatusOutput>(
          {
            method: "POST",
            path: `/v1/groups/${encodeURIComponent(input.groupID)}/status`,
            body: { expectedVersion: input["expectedVersion"], status: input["status"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      members: (input: SkillMarketGroupsMembersInput, requestOptions?: RequestOptions) =>
        request<SkillMarketGroupsMembersOutput>(
          {
            method: "GET",
            path: `/v1/groups/${encodeURIComponent(input.groupID)}/members`,
            successStatus: 200,
            declaredStatuses: [404, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
      addMember: (input: SkillMarketGroupsAddMemberInput, requestOptions?: RequestOptions) =>
        request<SkillMarketGroupsAddMemberOutput>(
          {
            method: "POST",
            path: `/v1/groups/${encodeURIComponent(input.groupID)}/members`,
            body: { expectedVersion: input["expectedVersion"], employeeID: input["employeeID"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      removeMember: (input: SkillMarketGroupsRemoveMemberInput, requestOptions?: RequestOptions) =>
        request<SkillMarketGroupsRemoveMemberOutput>(
          {
            method: "DELETE",
            path: `/v1/groups/${encodeURIComponent(input.groupID)}/members/${encodeURIComponent(input.employeeID)}`,
            body: { expectedVersion: input["expectedVersion"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    skillMarketSharing: {
      promote: (input: SkillMarketSharingPromoteInput, requestOptions?: RequestOptions) =>
        request<SkillMarketSharingPromoteOutput>(
          {
            method: "POST",
            path: `/v1/submissions/${encodeURIComponent(input.submissionID)}/promotions`,
            body: { expectedVersion: input["expectedVersion"], target: input["target"], audience: input["audience"] },
            successStatus: 202,
            declaredStatuses: [404, 400, 409, 413, 422, 429, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      audienceChange: (input: SkillMarketSharingAudienceChangeInput, requestOptions?: RequestOptions) =>
        request<SkillMarketSharingAudienceChangeOutput>(
          {
            method: "POST",
            path: `/v1/submissions/${encodeURIComponent(input.submissionID)}/audience-changes`,
            body: { expectedVersion: input["expectedVersion"], target: input["target"], audience: input["audience"] },
            successStatus: 202,
            declaredStatuses: [404, 400, 409, 413, 422, 429, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    "skillMarket.submissionLifecycle": {
      personalTrash: (requestOptions?: RequestOptions) =>
        request<SkillMarketSubmissionLifecyclePersonalTrashOutput>(
          { method: "GET", path: `/v1/personal-trash`, successStatus: 200, declaredStatuses: [503, 401], empty: false },
          requestOptions,
        ),
      personalDelete: (input: SkillMarketSubmissionLifecyclePersonalDeleteInput, requestOptions?: RequestOptions) =>
        request<SkillMarketSubmissionLifecyclePersonalDeleteOutput>(
          {
            method: "DELETE",
            path: `/v1/submissions/${encodeURIComponent(input.submissionID)}/personal`,
            body: { expectedVersion: input["expectedVersion"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 413, 422, 429, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      personalRestore: (input: SkillMarketSubmissionLifecyclePersonalRestoreInput, requestOptions?: RequestOptions) =>
        request<SkillMarketSubmissionLifecyclePersonalRestoreOutput>(
          {
            method: "POST",
            path: `/v1/personal-trash/${encodeURIComponent(input.submissionID)}/restore`,
            body: { expectedVersion: input["expectedVersion"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 413, 422, 429, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      withdraw: (input: SkillMarketSubmissionLifecycleWithdrawInput, requestOptions?: RequestOptions) =>
        request<SkillMarketSubmissionLifecycleWithdrawOutput>(
          {
            method: "POST",
            path: `/v1/submissions/${encodeURIComponent(input.submissionID)}/withdraw`,
            body: { expectedVersion: input["expectedVersion"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 413, 422, 429, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      requestDelist: (input: SkillMarketSubmissionLifecycleRequestDelistInput, requestOptions?: RequestOptions) =>
        request<SkillMarketSubmissionLifecycleRequestDelistOutput>(
          {
            method: "POST",
            path: `/v1/submissions/${encodeURIComponent(input.submissionID)}/delist-requests`,
            body: { expectedVersion: input["expectedVersion"], reason: input["reason"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 413, 422, 429, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      pendingDelist: (input: SkillMarketSubmissionLifecyclePendingDelistInput, requestOptions?: RequestOptions) =>
        request<SkillMarketSubmissionLifecyclePendingDelistOutput>(
          {
            method: "GET",
            path: `/v1/submissions/${encodeURIComponent(input.submissionID)}/delist-requests`,
            successStatus: 200,
            declaredStatuses: [404, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    "skillMarket.adminLifecycle": {
      pendingDelist: (input: SkillMarketAdminLifecyclePendingDelistInput, requestOptions?: RequestOptions) =>
        request<SkillMarketAdminLifecyclePendingDelistOutput>(
          {
            method: "GET",
            path: `/v1/admin/submissions/${encodeURIComponent(input.submissionID)}/delist-requests`,
            successStatus: 200,
            declaredStatuses: [400, 404, 409, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      listDelist: (input?: SkillMarketAdminLifecycleListDelistInput, requestOptions?: RequestOptions) =>
        request<SkillMarketAdminLifecycleListDelistOutput>(
          {
            method: "GET",
            path: `/v1/admin/delist-requests`,
            query: { page: input?.["page"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [400, 404, 409, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      approveDelist: (input: SkillMarketAdminLifecycleApproveDelistInput, requestOptions?: RequestOptions) =>
        request<SkillMarketAdminLifecycleApproveDelistOutput>(
          {
            method: "POST",
            path: `/v1/admin/delist-requests/${encodeURIComponent(input.requestID)}/approve`,
            body: { expectedVersion: input["expectedVersion"] },
            successStatus: 200,
            declaredStatuses: [400, 404, 409, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
      rejectDelist: (input: SkillMarketAdminLifecycleRejectDelistInput, requestOptions?: RequestOptions) =>
        request<SkillMarketAdminLifecycleRejectDelistOutput>(
          {
            method: "POST",
            path: `/v1/admin/delist-requests/${encodeURIComponent(input.requestID)}/reject`,
            body: { expectedVersion: input["expectedVersion"] },
            successStatus: 200,
            declaredStatuses: [400, 404, 409, 503, 403, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
  }
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item)
    return
  }
  if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item)
    return
  }
  params.append(key, String(value))
}

async function json(response: Response): Promise<unknown> {
  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnsupportedContentType")
  }
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    throw new ClientError("Transport", { cause })
  }
  if (text === "") throw new ClientError("MalformedResponse")
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ClientError("MalformedResponse", { cause })
  }
}

function isContentType(response: Response, expected: string) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected
}
