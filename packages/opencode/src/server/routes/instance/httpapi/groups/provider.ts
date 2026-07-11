import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"

import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ProviderV2 } from "@opencode-ai/core/provider"

const root = "/provider"

const ProviderAuthErrorName = Schema.Union([
  Schema.Literal("BadRequest"),
  Schema.Literal("ProviderAuthOauthMissing"),
  Schema.Literal("ProviderAuthOauthCodeMissing"),
  Schema.Literal("ProviderAuthOauthCallbackFailed"),
  Schema.Literal("ProviderAuthValidationFailed"),
  Schema.Literal("ProviderAuthLoginRequired"),
])
export class ProviderAuthApiError extends Schema.ErrorClass<ProviderAuthApiError>("ProviderAuthError")(
  {
    name: ProviderAuthErrorName,
    data: Schema.Struct({
      providerID: Schema.optional(ProviderV2.ID),
      field: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.String),
    }),
  },
  { httpApiStatus: 400 },
) {}

export const RuyingSessionUser = Schema.Struct({
  employeeId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
})

export const RuyingSessionStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
  user: Schema.optional(RuyingSessionUser),
})

export class RuyingSessionLogoutApiError extends Schema.ErrorClass<RuyingSessionLogoutApiError>(
  "RuyingSessionLogoutError",
)(
  { message: Schema.String },
  { httpApiStatus: 500 },
) {}

export const ProviderApi = HttpApi.make("provider")
  .add(
    HttpApiGroup.make("provider")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Provider.ListResult, "List of providers"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.list",
            summary: "List providers",
            description: "Get a list of all available AI providers, including both available and connected ones.",
          }),
        ),
        HttpApiEndpoint.get("auth", `${root}/auth`, {
          query: WorkspaceRoutingQuery,
          success: described(ProviderAuth.Methods, "Provider auth methods"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.auth",
            summary: "Get provider auth methods",
            description: "Retrieve available authentication methods for all AI providers.",
          }),
        ),
        HttpApiEndpoint.get("ruyingStatus", `${root}/ruying/session`, {
          query: WorkspaceRoutingQuery,
          success: described(RuyingSessionStatus, "Authoritative Ruying login status"),
          error: RuyingSessionLogoutApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.ruying.status",
            summary: "Get Ruying login status",
            description: "Freshly verify the stored Ruying credential and persisted GWM SSO identity.",
          }),
        ),
        HttpApiEndpoint.delete("ruyingLogout", `${root}/ruying/session`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Ruying logout completed"),
          error: RuyingSessionLogoutApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.ruying.logout",
            summary: "Log out of Ruying",
            description: "Transactionally remove the Ruying credential and persisted GWM SSO identity.",
          }),
        ),
        HttpApiEndpoint.post("authorize", `${root}/:providerID/oauth/authorize`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAuth.AuthorizeInput,
          success: described(Schema.UndefinedOr(ProviderAuth.Authorization), "Authorization URL and method"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.authorize",
            summary: "Start OAuth authorization",
            description: "Start the OAuth authorization flow for a provider.",
          }),
        ),
        HttpApiEndpoint.post("callback", `${root}/:providerID/oauth/callback`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          payload: ProviderAuth.CallbackInput,
          success: described(Schema.Boolean, "OAuth callback processed successfully"),
          error: ProviderAuthApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.callback",
            summary: "Handle OAuth callback",
            description: "Handle the OAuth callback from a provider after user authorization.",
          }),
        ),
        HttpApiEndpoint.post("cancel", `${root}/:providerID/oauth/cancel`, {
          params: { providerID: ProviderV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "OAuth authorization canceled"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.cancel",
            summary: "Cancel OAuth authorization",
            description: "Cancel the pending OAuth authorization attempt for a provider.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "provider",
          description: "Experimental HttpApi provider routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
