import { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  SkillMarketControlNotFound,
  SkillMarketDependencyUnavailable,
  SkillMarketInvalidRequest,
  SkillMarketSubmissionConflict,
} from "../skill-market-errors"
import { SkillMarketSessionMiddleware, SkillMarketWriteMiddleware } from "../skill-market-middleware"

const GroupParams = { groupID: SkillMarketControl.GroupID }
const GroupMemberParams = { ...GroupParams, employeeID: SkillMarketControl.EmployeeID }
const WriteErrors = [
  SkillMarketInvalidRequest,
  SkillMarketSubmissionConflict,
  SkillMarketDependencyUnavailable,
] as const

export const SkillMarketGroupsGroup = HttpApiGroup.make("skillMarket.groups")
  .add(
    HttpApiEndpoint.get("skillMarket.groups.list", "/v1/groups", {
      success: SkillMarketControl.GroupPage,
      error: SkillMarketDependencyUnavailable,
    }),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.groups.create", "/v1/groups", {
      payload: SkillMarketControl.GroupCreateInput,
      success: SkillMarketControl.MarketGroup,
      error: WriteErrors,
    }).middleware(SkillMarketWriteMiddleware),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.groups.detail", "/v1/groups/:groupID", {
      params: GroupParams,
      success: SkillMarketControl.MarketGroup,
      error: [SkillMarketControlNotFound, SkillMarketDependencyUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.patch("skillMarket.groups.update", "/v1/groups/:groupID", {
      params: GroupParams,
      payload: SkillMarketControl.GroupUpdateInput,
      success: SkillMarketControl.MarketGroup,
      error: [SkillMarketControlNotFound, ...WriteErrors],
    }).middleware(SkillMarketWriteMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.groups.transfer", "/v1/groups/:groupID/ownership", {
      params: GroupParams,
      payload: SkillMarketControl.GroupOwnerInput,
      success: SkillMarketControl.MarketGroup,
      error: [SkillMarketControlNotFound, ...WriteErrors],
    }).middleware(SkillMarketWriteMiddleware),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.groups.setStatus", "/v1/groups/:groupID/status", {
      params: GroupParams,
      payload: SkillMarketControl.GroupStatusInput,
      success: SkillMarketControl.MarketGroup,
      error: [SkillMarketControlNotFound, ...WriteErrors],
    }).middleware(SkillMarketWriteMiddleware),
  )
  .add(
    HttpApiEndpoint.get("skillMarket.groups.members", "/v1/groups/:groupID/members", {
      params: GroupParams,
      success: Schema.Array(SkillMarketControl.MarketGroupMember),
      error: [SkillMarketControlNotFound, SkillMarketDependencyUnavailable],
    }),
  )
  .add(
    HttpApiEndpoint.post("skillMarket.groups.addMember", "/v1/groups/:groupID/members", {
      params: GroupParams,
      payload: SkillMarketControl.GroupMemberInput,
      success: SkillMarketControl.MarketGroupMember,
      error: [SkillMarketControlNotFound, ...WriteErrors],
    }).middleware(SkillMarketWriteMiddleware),
  )
  .add(
    HttpApiEndpoint.delete("skillMarket.groups.removeMember", "/v1/groups/:groupID/members/:employeeID", {
      params: GroupMemberParams,
      payload: SkillMarketControl.GroupMemberRemoveInput,
      success: SkillMarketControl.MarketGroup,
      error: [SkillMarketControlNotFound, ...WriteErrors],
    }).middleware(SkillMarketWriteMiddleware),
  )
  .middleware(SkillMarketSessionMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "Ruying Skill Groups", description: "Authenticated custom groups." }))
