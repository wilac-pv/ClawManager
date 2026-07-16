import { A, useLocation } from "@solidjs/router"
import { For, Show, type ParentProps } from "solid-js"
import { useSkillMarketSession } from "./session"

export function MarketShell(props: ParentProps) {
  const current = useSkillMarketSession()
  const location = useLocation()
  const links = () => [
    { href: "/skills", label: "Skill 市场", visible: true },
    { href: "/submissions", label: "我的投稿", visible: Boolean(current.session()) },
    { href: "/admin", label: "管理后台", visible: current.reviewer() },
    { href: "/admin/roles", label: "角色管理", visible: current.admin() },
    { href: "/admin/audit", label: "审计日志", visible: current.admin() },
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
              <A href={link.href} end activeClass="is-active">
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
