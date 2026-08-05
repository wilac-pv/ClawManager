import { A, useLocation } from "@solidjs/router"
import { For, type ParentProps } from "solid-js"

export function MySpaceLayout(props: ParentProps) {
  const location = useLocation()
  const links = [
    { href: "/personal", label: "个人 Skill" },
    { href: "/submissions", label: "我的投稿" },
    { href: "/favorites", label: "我的收藏" },
    { href: "/trash", label: "回收站" },
    { href: "/groups", label: "我的小组" },
  ]
  const active = (href: string) => {
    if (href === "/personal")
      return (
        location.pathname === "/personal" ||
        (location.pathname === "/submissions/new" && new URLSearchParams(location.search).get("target") === "personal")
      )
    if (href === "/favorites") return location.pathname === "/favorites"
    if (href === "/trash") return location.pathname === "/trash"
    if (href === "/groups") return location.pathname === "/groups" || location.pathname.startsWith("/groups/")
    return (
      location.pathname.startsWith("/submissions") &&
      !(location.pathname === "/submissions/new" && new URLSearchParams(location.search).get("target") === "personal")
    )
  }

  return (
    <div class="my-space">
      <div class="my-space__header">
        <div>
          <p>个人空间</p>
          <strong>我的空间</strong>
        </div>
        <span>当前账号专属</span>
      </div>
      <nav class="my-space__nav" aria-label="我的空间子菜单">
        <For each={links}>
          {(link) => (
            <A
              href={link.href}
              classList={{ "is-active": active(link.href) }}
              aria-current={active(link.href) ? "page" : undefined}
            >
              {link.label}
            </A>
          )}
        </For>
      </nav>
      <div class="my-space__content">{props.children}</div>
    </div>
  )
}
