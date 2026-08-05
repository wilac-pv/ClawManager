import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render } from "@solidjs/testing-library"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { MySpaceLayout } from "./layout"

afterEach(() => cleanup())

describe("my space layout", () => {
  test("shows one space with personal, submission, and favorite sections", () => {
    const view = renderLayout("/personal")

    expect(view.getByText("我的空间")).toBeTruthy()
    expect(view.getByRole("link", { name: "个人 Skill" }).getAttribute("aria-current")).toBe("page")
    expect(view.getByRole("link", { name: "我的投稿" })).toBeTruthy()
    expect(view.getByRole("link", { name: "我的收藏" })).toBeTruthy()
    expect(view.getByRole("link", { name: "回收站" })).toBeTruthy()
    expect(view.getByRole("link", { name: "我的小组" })).toBeTruthy()
    expect(view.queryByRole("banner")).toBeNull()
  })

  test("marks group list and detail routes active", () => {
    const view = renderLayout("/groups/grp_aurora1")
    expect(view.getByRole("link", { name: "我的小组" }).getAttribute("aria-current")).toBe("page")
  })

  test("marks company submissions and favorites active", () => {
    const submissions = renderLayout("/submissions")
    expect(submissions.getByRole("link", { name: "我的投稿" }).getAttribute("aria-current")).toBe("page")
    cleanup()

    const trash = renderLayout("/trash")
    expect(trash.getByRole("link", { name: "回收站" }).getAttribute("aria-current")).toBe("page")
    cleanup()

    const favorites = renderLayout("/favorites")
    expect(favorites.getByRole("link", { name: "我的收藏" }).getAttribute("aria-current")).toBe("page")
  })

  test("keeps personal uploads under personal Skill", () => {
    const view = renderLayout("/submissions/new?target=personal")

    expect(view.getByRole("link", { name: "个人 Skill" }).getAttribute("aria-current")).toBe("page")
    expect(view.getByRole("link", { name: "我的投稿" }).getAttribute("aria-current")).toBeNull()
  })
})

function renderLayout(path: string) {
  const history = createMemoryHistory()
  history.set({ value: path, replace: true })
  return render(() => (
    <MemoryRouter history={history}>
      <Route
        path="*"
        component={() => (
          <MySpaceLayout>
            <div>空间内容</div>
          </MySpaceLayout>
        )}
      />
    </MemoryRouter>
  ))
}
