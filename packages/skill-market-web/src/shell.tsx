import { A, useLocation } from "@solidjs/router"
import { For, Show, type ParentProps } from "solid-js"
import { useSkillMarketSession } from "./session"

export function MarketShell(props: ParentProps) {
  const current = useSkillMarketSession()
  const location = useLocation()
  const links = () => [
    { href: "/skills", label: "Skill 市场", visible: true },
    { href: "/announcements", label: "公告", visible: true },
    { href: "/expert-packages", label: "专家包", visible: true },
    { href: "/personal", label: "我的空间", visible: Boolean(current.session()) },
    { href: "/admin", label: "管理后台", visible: current.reviewer() },
  ]

  return (
    <div class="market-shell">
      <header class="market-shell__header">
        <A class="market-shell__brand" href="/skills" aria-label="如影 Code Skill 市场首页">
          <span class="market-shell__brand-mark" aria-hidden="true">
            如
          </span>
          <span>如影 Code</span>
        </A>
        <nav class="market-shell__nav" aria-label="Skill 市场主导航">
          <For each={links().filter((link) => link.visible)}>
            {(link) => (
              <A
                href={link.href}
                end
                activeClass="is-active"
                classList={{
                  "is-active": link.href === "/admin" && location.pathname.startsWith("/admin"),
                  "is-space-active":
                    link.href === "/personal" &&
                    (location.pathname === "/personal" ||
                      location.pathname === "/favorites" ||
                      location.pathname.startsWith("/submissions")),
                }}
                aria-current={
                  (link.href === "/admin" && location.pathname.startsWith("/admin")) ||
                  (link.href === "/personal" &&
                    (location.pathname === "/personal" ||
                      location.pathname === "/favorites" ||
                      location.pathname.startsWith("/submissions")))
                    ? "page"
                    : undefined
                }
              >
                {link.label}
              </A>
            )}
          </For>
        </nav>
        <div class="market-shell__account">
          <Show
            when={!current.loading() && current.session()}
            fallback={
              <Show when={!current.loading()}>
                <button type="button" class="market-primary-action" onClick={() => current.login(location.pathname)}>
                  使用 GWM SSO 登录
                </button>
              </Show>
            }
          >
            {(session) => (
              <>
                <span class="market-shell__identity">
                  <strong data-identity-name>{session().user.displayName}</strong>
                  <small data-identity-id>{session().user.employeeID}</small>
                </span>
                <button type="button" class="market-shell__logout" onClick={() => void current.logout()}>
                  退出登录
                </button>
              </>
            )}
          </Show>
        </div>
      </header>
      <div class="market-shell__content">{props.children}</div>
    </div>
  )
}
