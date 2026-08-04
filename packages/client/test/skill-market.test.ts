import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { OpenCode } from "../src"
import { SkillMarketControl } from "../src/skill-market-control"
import { SkillMarketControlEffect } from "../src/skill-market-control-effect"

test("generated client exposes every local Skill market operation", () => {
  const client = OpenCode.make({ baseUrl: "http://127.0.0.1:1" })

  expect(Object.keys(client.skillMarket).toSorted()).toEqual([
    "detail",
    "facets",
    "install",
    "installed",
    "list",
    "refresh",
    "uninstall",
    "update",
    "updates",
  ])
})

test("generated clients expose callable scoped sharing operations", async () => {
  const requests: Array<{ readonly url: string; readonly method: string; readonly body: unknown }> = []
  const requestFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const status = String(input).includes("/promotions") || String(input).includes("/audience-changes") ? 202 : 200
    return new Response("{}", { status, headers: { "content-type": "application/json" } })
  }
  const client = SkillMarketControl.make({ baseUrl: "https://skill-market.example", fetch: requestFetch })

  expect(Object.keys(client.skillMarketGroups).toSorted()).toEqual([
    "addMember",
    "create",
    "detail",
    "list",
    "members",
    "removeMember",
    "setStatus",
    "transfer",
    "update",
  ])
  expect(Object.keys(client.skillMarketSharing).toSorted()).toEqual(["audienceChange", "promote"])
  expect(Object.keys(client.skillMarketRestricted)).toEqual(["privateInstallGrant"])

  await client.skillMarketGroups.create({ name: "Reviewers", description: "Reviews scoped skills" })
  await client.skillMarketSharing.promote({
    submissionID: "sub_abcdefgh",
    expectedVersion: 1,
    target: "company",
  })
  await client.skillMarketSharing.audienceChange({
    submissionID: "sub_abcdefgh",
    expectedVersion: 2,
    target: "groups",
    audience: { scope: "groups", groupIDs: ["grp_abcdefgh"] },
  })
  await client.skillMarketRestricted.privateInstallGrant({ publicationID: "pub_abcdefgh" })

  expect(requests).toEqual([
    {
      url: "https://skill-market.example/v1/groups",
      method: "POST",
      body: { name: "Reviewers", description: "Reviews scoped skills" },
    },
    {
      url: "https://skill-market.example/v1/submissions/sub_abcdefgh/promotions",
      method: "POST",
      body: { expectedVersion: 1, target: "company" },
    },
    {
      url: "https://skill-market.example/v1/submissions/sub_abcdefgh/audience-changes",
      method: "POST",
      body: {
        expectedVersion: 2,
        target: "groups",
        audience: { scope: "groups", groupIDs: ["grp_abcdefgh"] },
      },
    },
    {
      url: "https://skill-market.example/v1/restricted-skills/pub_abcdefgh/install-grants",
      method: "POST",
      body: undefined,
    },
  ])

  const effectRequests: Array<{ readonly url: string; readonly method: string; readonly body: unknown }> = []
  const effectHttpClient = HttpClient.make((request) => {
    effectRequests.push({
      url: request.url,
      method: request.method,
      body:
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined,
    })
    if (request.url.includes("/install-grants")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ url: "https://skill-market.example/download", expiresAt: "2026-08-04T00:00:00Z" }),
        ),
      )
    }
    if (request.url.includes("/promotions") || request.url.includes("/audience-changes")) {
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(acceptedSubmission, { status: 202 })))
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(marketGroup)))
  })

  await Effect.gen(function* () {
    const effectClient = yield* SkillMarketControlEffect.make({ baseUrl: "https://skill-market.example" })
    yield* effectClient.skillMarketGroups.create({ name: "Reviewers", description: "Reviews scoped skills" })
    yield* effectClient.skillMarketSharing.promote({
      submissionID: "sub_abcdefgh",
      expectedVersion: 1,
      target: "company",
    })
    yield* effectClient.skillMarketSharing.audienceChange({
      submissionID: "sub_abcdefgh",
      expectedVersion: 2,
      target: "groups",
      audience: { scope: "groups", groupIDs: ["grp_abcdefgh"] },
    })
    yield* effectClient.skillMarketRestricted.privateInstallGrant({ publicationID: "pub_abcdefgh" })
  }).pipe(Effect.provideService(HttpClient.HttpClient, effectHttpClient), Effect.runPromise)

  expect(effectRequests).toEqual(requests)
})

const marketGroup = {
  id: "grp_abcdefgh",
  name: "Reviewers",
  ownerEmployeeID: "owner",
  status: "active",
  version: 1,
  createdAt: "2026-08-04T00:00:00Z",
  updatedAt: "2026-08-04T00:00:00Z",
}

const acceptedSubmission = {
  submission: {
    id: "sub_abcdefgh",
    skillID: "reviewed-skill",
    owner: { employeeID: "owner", displayName: "Owner" },
    targetVersion: "1.0.0",
    status: "pending_review",
    currentRevision: 1,
    version: 1,
    risk: "safe",
    createdAt: "2026-08-04T00:00:00Z",
    updatedAt: "2026-08-04T00:00:00Z",
  },
}
