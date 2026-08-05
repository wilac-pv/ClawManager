import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { SkillMarket } from "@opencode-ai/schema/skill-market"
import { Schema } from "effect"

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface ControlDataSourceOptions {
  readonly allowInsecurePrivateHttp?: boolean
  readonly csrfToken?: () => string | undefined
  readonly fetcher?: Fetcher
}

interface SubmissionUpload {
  readonly target?: SkillMarketControl.PublicationTarget
  readonly audience?: SkillMarketControl.AudienceInput
  readonly metadata: SkillMarketControl.SubmissionMetadata
  readonly package: File
  readonly icon?: File
}

interface RevisionUpload extends SubmissionUpload {
  readonly expectedVersion: number
}

export class MarketControlError extends Error {
  override readonly name = "MarketControlError"

  constructor(
    readonly status: number,
    readonly code: SkillMarketControl.ProblemCode,
    message: string,
    readonly requestId: string,
  ) {
    super(message)
  }
}

export function createSkillMarketControlDataSource(baseUrl: string, options: ControlDataSourceOptions = {}) {
  const base = requireSecureBaseUrl(baseUrl, options.allowInsecurePrivateHttp)
  const fetcher = options.fetcher ?? fetch
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (!headers.has("accept")) headers.set("accept", "application/json")
    const response = await fetcher(new URL(path, base), {
      ...init,
      credentials: "include",
      headers,
    })
    if (response.ok) return response
    const problem = await response
      .json()
      .then((value) => Schema.decodeUnknownPromise(SkillMarketControl.Problem)(value))
    throw new MarketControlError(response.status, problem.code, problem.message, problem.requestId)
  }
  const read = async <S extends Schema.Decoder<unknown>>(path: string, schema: S, signal?: AbortSignal) =>
    Schema.decodeUnknownPromise(schema)(await (await send(path, { signal })).json())
  const write = async <S extends Schema.Decoder<unknown>>(
    path: string,
    schema: S,
    input: unknown,
    signal?: AbortSignal,
  ) =>
    Schema.decodeUnknownPromise(schema)(
      await (
        await send(path, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", "x-csrf-token": requireCsrf(options.csrfToken) },
          body: JSON.stringify(input),
        })
      ).json(),
    )
  const upload = async (
    path: string,
    input: SubmissionUpload | RevisionUpload,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => {
    const form = new FormData()
    form.set(
      "metadata",
      JSON.stringify(
        "expectedVersion" in input
          ? { expectedVersion: input.expectedVersion, metadata: input.metadata }
          : {
              target: input.target ?? "company",
              ...(input.audience ? { audience: input.audience } : {}),
              metadata: input.metadata,
            },
      ),
    )
    form.set("package", input.package)
    if (input.icon) form.set("icon", input.icon)
    return Schema.decodeUnknownPromise(SkillMarketControl.AcceptedSubmission)(
      await (
        await send(path, {
          method: "POST",
          signal,
          headers: {
            "idempotency-key": requireIdempotencyKey(idempotencyKey),
            "x-csrf-token": requireCsrf(options.csrfToken),
          },
          body: form,
        })
      ).json(),
    )
  }
  const mutate = async <S extends Schema.Decoder<unknown>>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    schema: S,
    input: unknown,
    request: { readonly idempotencyKey?: string; readonly signal?: AbortSignal } = {},
  ) =>
    Schema.decodeUnknownPromise(schema)(
      await (
        await send(path, {
          method,
          signal: request.signal,
          headers: {
            "content-type": "application/json",
            "x-csrf-token": requireCsrf(options.csrfToken),
            ...(request.idempotencyKey
              ? { "idempotency-key": requireIdempotencyKey(request.idempotencyKey) }
              : {}),
          },
          body: JSON.stringify(input),
        })
      ).json(),
    )

  return {
    auth: {
      loginUrl(returnTo: string) {
        const query = new URLSearchParams({ returnTo })
        return new URL(`/v1/auth/login?${query}`, base).toString()
      },
      session: (signal?: AbortSignal) => read("/v1/auth/session", SkillMarketControl.SessionState, signal),
      async logout(signal?: AbortSignal) {
        const response = await send("/v1/auth/session", {
          method: "DELETE",
          signal,
          headers: { "x-csrf-token": requireCsrf(options.csrfToken) },
        })
        if (response.status !== 204) throw new Error("Skill market logout returned an invalid response")
      },
    },
    favorites: {
      list: (signal?: AbortSignal) => read("/v1/favorites", Schema.Array(SkillMarket.Favorite), signal),
      async add(source: SkillMarket.Source, id: string, signal?: AbortSignal) {
        const response = await send(`/v1/favorites/${source}/${encodeURIComponent(id)}`, {
          method: "POST",
          signal,
          headers: { "x-csrf-token": requireCsrf(options.csrfToken) },
        })
        return Schema.decodeUnknownPromise(SkillMarket.Favorite)(await response.json())
      },
      async remove(source: SkillMarket.Source, id: string, signal?: AbortSignal) {
        const response = await send(`/v1/favorites/${source}/${encodeURIComponent(id)}`, {
          method: "DELETE",
          signal,
          headers: { "x-csrf-token": requireCsrf(options.csrfToken) },
        })
        if (response.status !== 204) throw new Error("Skill market favorite removal returned an invalid response")
      },
    },
    announcements: {
      publish: (input: SkillMarketControl.AnnouncementCreateInput, signal?: AbortSignal) =>
        write("/v1/admin/announcements", SkillMarket.AnnouncementDetail, input, signal),
    },
    submissions: {
      list: (query: SkillMarketControl.SubmissionListQuery, signal?: AbortSignal) =>
        read(
          withQuery("/v1/submissions", [
            ["status", query.status],
            ["target", query.target],
            ["page", query.page],
            ["limit", query.limit],
          ]),
          SkillMarketControl.SubmissionPage,
          signal,
        ),
      create: (input: SubmissionUpload, idempotencyKey: string, signal?: AbortSignal) =>
        upload("/v1/submissions", input, idempotencyKey, signal),
      detail: (submissionID: string, signal?: AbortSignal) =>
        read(`/v1/submissions/${encodeURIComponent(submissionID)}`, SkillMarketControl.SubmissionDetail, signal),
      packageUrl: (submissionID: string) =>
        new URL(`/v1/submissions/${encodeURIComponent(submissionID)}/package`, base).href,
      revise: (submissionID: string, input: RevisionUpload, idempotencyKey: string, signal?: AbortSignal) =>
        upload(`/v1/submissions/${encodeURIComponent(submissionID)}/revisions`, input, idempotencyKey, signal),
      promote: (
        submissionID: string,
        input: SkillMarketControl.PromotionInput,
        idempotencyKey: string,
        signal?: AbortSignal,
      ) =>
        mutate(
          "POST",
          `/v1/submissions/${encodeURIComponent(submissionID)}/promotions`,
          SkillMarketControl.AcceptedSubmission,
          input,
          { idempotencyKey, signal },
        ),
      changeAudience: (
        submissionID: string,
        input: SkillMarketControl.AudienceChangeInput,
        idempotencyKey: string,
        signal?: AbortSignal,
      ) =>
        mutate(
          "POST",
          `/v1/submissions/${encodeURIComponent(submissionID)}/audience-changes`,
          SkillMarketControl.AcceptedSubmission,
          input,
          { idempotencyKey, signal },
        ),
    },
    groups: {
      list: (signal?: AbortSignal) => read("/v1/groups", SkillMarketControl.GroupPage, signal),
      create: (input: SkillMarketControl.GroupCreateInput, signal?: AbortSignal) =>
        mutate("POST", "/v1/groups", SkillMarketControl.MarketGroup, input, { signal }),
      detail: (groupID: string, signal?: AbortSignal) =>
        read(`/v1/groups/${encodeURIComponent(groupID)}`, SkillMarketControl.MarketGroup, signal),
      update: (groupID: string, input: SkillMarketControl.GroupUpdateInput, signal?: AbortSignal) =>
        mutate("PATCH", `/v1/groups/${encodeURIComponent(groupID)}`, SkillMarketControl.MarketGroup, input, { signal }),
      transfer: (groupID: string, input: SkillMarketControl.GroupOwnerInput, signal?: AbortSignal) =>
        mutate(
          "POST",
          `/v1/groups/${encodeURIComponent(groupID)}/ownership`,
          SkillMarketControl.MarketGroup,
          input,
          { signal },
        ),
      setStatus: (groupID: string, input: SkillMarketControl.GroupStatusInput, signal?: AbortSignal) =>
        mutate(
          "POST",
          `/v1/groups/${encodeURIComponent(groupID)}/status`,
          SkillMarketControl.MarketGroup,
          input,
          { signal },
        ),
      members: (groupID: string, signal?: AbortSignal) =>
        read(
          `/v1/groups/${encodeURIComponent(groupID)}/members`,
          Schema.Array(SkillMarketControl.MarketGroupMember),
          signal,
        ),
      addMember: (groupID: string, input: SkillMarketControl.GroupMemberInput, signal?: AbortSignal) =>
        mutate(
          "POST",
          `/v1/groups/${encodeURIComponent(groupID)}/members`,
          SkillMarketControl.MarketGroupMember,
          input,
          { signal },
        ),
      removeMember: (
        groupID: string,
        employeeID: string,
        input: SkillMarketControl.GroupMemberRemoveInput,
        signal?: AbortSignal,
      ) =>
        mutate(
          "DELETE",
          `/v1/groups/${encodeURIComponent(groupID)}/members/${encodeURIComponent(employeeID)}`,
          SkillMarketControl.MarketGroup,
          input,
          { signal },
        ),
    },
    restricted: {
      detail: (publicationID: string, signal?: AbortSignal) =>
        read(
          `/v1/restricted-skills/${encodeURIComponent(publicationID)}`,
          SkillMarket.RestrictedDetail,
          signal,
        ),
      versions: (publicationID: string, signal?: AbortSignal) =>
        read(
          `/v1/restricted-skills/${encodeURIComponent(publicationID)}/versions`,
          Schema.Array(SkillMarket.Version),
          signal,
        ),
      installGrant: (publicationID: string, signal?: AbortSignal) =>
        mutate(
          "POST",
          `/v1/restricted-skills/${encodeURIComponent(publicationID)}/install-grants`,
          SkillMarket.PrivateInstallGrant,
          {},
          { signal },
        ),
    },
    moderation: {
      list: (query: SkillMarketControl.AdminSubmissionQuery, signal?: AbortSignal) =>
        read(
          withQuery("/v1/admin/submissions", [
            ["status", query.status],
            ["risk", query.risk],
            ["submitter", query.submitter],
            ["createdFrom", query.createdFrom],
            ["createdTo", query.createdTo],
            ["page", query.page],
            ["limit", query.limit],
          ]),
          SkillMarketControl.SubmissionPage,
          signal,
        ),
      detail: (submissionID: string, signal?: AbortSignal) =>
        read(`/v1/admin/submissions/${encodeURIComponent(submissionID)}`, SkillMarketControl.SubmissionDetail, signal),
      decide: (submissionID: string, input: SkillMarketControl.DecisionInput, signal?: AbortSignal) =>
        write(
          `/v1/admin/submissions/${encodeURIComponent(submissionID)}/decision`,
          SkillMarketControl.SubmissionDetail,
          input,
          signal,
        ),
      retryPublish: (submissionID: string, input: SkillMarketControl.ExpectedVersionInput, signal?: AbortSignal) =>
        write(
          `/v1/admin/submissions/${encodeURIComponent(submissionID)}/retry-publish`,
          SkillMarketControl.SubmissionDetail,
          input,
          signal,
        ),
      delist: (skillID: string, input: SkillMarketControl.ReasonInput, signal?: AbortSignal) =>
        write(
          `/v1/admin/community-skills/${encodeURIComponent(skillID)}/delist`,
          SkillMarketControl.PublicSkill,
          input,
          signal,
        ),
      restore: (skillID: string, input: SkillMarketControl.ReasonInput, signal?: AbortSignal) =>
        write(
          `/v1/admin/community-skills/${encodeURIComponent(skillID)}/restore`,
          SkillMarketControl.PublicSkill,
          input,
          signal,
        ),
    },
    roles: {
      list: (signal?: AbortSignal) => read("/v1/admin/roles", Schema.Array(SkillMarketControl.RoleAssignment), signal),
      assign: (input: SkillMarketControl.RoleInput, signal?: AbortSignal) =>
        write("/v1/admin/roles", SkillMarketControl.RoleAssignment, input, signal),
      async remove(employeeID: string, role: SkillMarketControl.Role, signal?: AbortSignal) {
        const response = await send(`/v1/admin/roles/${encodeURIComponent(employeeID)}/${encodeURIComponent(role)}`, {
          method: "DELETE",
          signal,
          headers: { "x-csrf-token": requireCsrf(options.csrfToken) },
        })
        return Schema.decodeUnknownPromise(Schema.Array(SkillMarketControl.RoleAssignment))(await response.json())
      },
    },
    audit: {
      list: (query: SkillMarketControl.AuditQuery, signal?: AbortSignal) =>
        read(
          withQuery("/v1/admin/audit", [
            ["actor", query.actor],
            ["action", query.action],
            ["objectType", query.objectType],
            ["objectID", query.objectID],
            ["createdFrom", query.createdFrom],
            ["createdTo", query.createdTo],
            ["page", query.page],
            ["limit", query.limit],
          ]),
          SkillMarketControl.AuditPage,
          signal,
      ),
    },
    skillhub: {
      status: (signal?: AbortSignal) =>
        read("/v1/admin/skillhub-import", SkillMarketControl.SkillHubImportProgress, signal),
      command: (input: SkillMarketControl.SkillHubImportCommandInput, signal?: AbortSignal) =>
        write("/v1/admin/skillhub-import/command", SkillMarketControl.SkillHubImportProgress, input, signal),
      evaluation: (signal?: AbortSignal) =>
        read("/v1/admin/skillhub-evaluation", SkillMarketControl.SkillHubEvaluationProgress, signal),
    },
  }
}

export type SkillMarketControlDataSource = ReturnType<typeof createSkillMarketControlDataSource>

function requireCsrf(read: (() => string | undefined) | undefined) {
  const value = read?.()
  if (!value || !/^[a-zA-Z0-9_-]{43}$/.test(value)) throw new Error("A valid Skill market CSRF token is required")
  return value
}

function requireIdempotencyKey(value: string) {
  if (/^[\x21-\x7e]{8,200}$/.test(value)) return value
  throw new Error("A valid Skill market idempotency key is required")
}

function withQuery(path: string, entries: ReadonlyArray<readonly [string, string | number | undefined]>) {
  const query = new URLSearchParams()
  entries.forEach(([key, value]) => {
    if (value !== undefined) query.set(key, String(value))
  })
  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}

function requireSecureBaseUrl(value: string, allowInsecurePrivateHttp?: boolean) {
  const url = new URL(value)
  if (url.username || url.password) throw new Error("Skill market API URL must not contain credentials")
  if (url.protocol === "https:") return url
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return url
  if (url.protocol === "http:" && allowInsecurePrivateHttp && privateIpv4(url.hostname)) return url
  throw new Error("Skill market API must use HTTPS outside loopback development")
}

function privateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31) return true
  return parts[0] === 192 && parts[1] === 168
}
