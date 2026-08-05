import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { PersonalTrash } from "./trash"

afterEach(() => cleanup())

describe("personal trash", () => {
  test("uses Chinese context for the trash eyebrow", () => {
    const view = render(() => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <PersonalTrash source={{ personalTrash: () => Promise.resolve([]), restorePersonal: () => Promise.resolve(item("2099-08-12T00:00:00.000Z")) }} />
      </QueryClientProvider>
    ))

    expect(view.container.textContent).not.toContain("Personal workspace")
    expect(view.container.textContent).toContain("个人空间")
  })

  test("shows purge deadlines and restores only recoverable personal Skills", async () => {
    const restores: unknown[][] = []
    const view = render(() => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <PersonalTrash
          source={{
            personalTrash: () => Promise.resolve([item("2099-08-12T00:00:00.000Z"), item("2000-08-12T00:00:00.000Z", "expired")]),
            restorePersonal: (...input) => {
              restores.push(input)
              return Promise.resolve(item("2099-08-12T00:00:00.000Z"))
            },
          }}
        />
      </QueryClientProvider>
    ))

    expect(await view.findAllByText("code-review")).toHaveLength(2)
    expect(view.getAllByText("1.2.0")).toHaveLength(2)
    expect(view.getAllByText(/永久删除时间/)).toHaveLength(2)
    expect(view.getByRole("button", { name: "恢复个人 Skill" })).toBeTruthy()
    expect(view.getByText(/已超过恢复期限/)).toBeTruthy()
    fireEvent.click(view.getByRole("button", { name: "恢复个人 Skill" }))
    await waitFor(() => expect(restores).toHaveLength(1))
    expect(restores[0]?.slice(0, 2)).toEqual(["sub_abcdefgh", { expectedVersion: 4 }])
  })
})

function item(purgeAfter: string, id = "active") {
  return {
    id: id === "active" ? "sub_abcdefgh" : "sub_ijklmnop",
    skillID: "code-review",
    owner: { employeeID: "E000001", displayName: "Contributor" },
    targetVersion: "1.2.0",
    status: "published" as const,
    target: "personal" as const,
    currentRevision: 1,
    version: 4,
    risk: "safe" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    deletedAt: "2026-08-05T00:00:00.000Z",
    purgeAfter,
  }
}
