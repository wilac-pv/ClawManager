import { A, useLocation } from "@solidjs/router"
import { For, type ParentProps } from "solid-js"
import { useSkillMarketSession } from "../session"

export function AdminLayout(props: ParentProps) {
  const current = useSkillMarketSession()
  const location = useLocation()
  const links = () => [
    { href: "/admin", label: "投稿审核", visible: current.reviewer() },
    { href: "/admin/roles", label: "角色管理", visible: current.admin() },
    { href: "/admin/audit", label: "审计日志", visible: current.admin() },
    { href: "/admin/skillhub", label: "SkillHub 同步", visible: current.admin() },
    { href: "/admin/announcements", label: "公告发布", visible: current.admin() },
    { href: "/admin/groups", label: "小组管理", visible: current.admin() },
  ]

  return (
    <div class="admin-workspace">
      <div class="admin-workspace__header">
        <div>
          <p>Ruying SkillHub administration</p>
          <strong>管理后台</strong>
        </div>
        <span>{current.admin() ? "管理员" : "审核员"}</span>
      </div>
      <nav class="admin-workspace__nav" aria-label="管理后台子菜单">
        <For each={links().filter((link) => link.visible)}>
          {(link) => (
            <A
              href={link.href}
              classList={{
                "is-active":
                  link.href === "/admin"
                    ? location.pathname === "/admin" || location.pathname.startsWith("/admin/submissions/")
                    : location.pathname === link.href,
              }}
            >
              {link.label}
            </A>
          )}
        </For>
      </nav>
      <div class="admin-workspace__content">{props.children}</div>
    </div>
  )
}
