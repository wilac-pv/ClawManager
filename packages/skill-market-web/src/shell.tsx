import { A, useLocation } from "@solidjs/router"
import { For, Show, type ParentProps } from "solid-js"
import { useSkillMarketSession } from "./session"

export function MarketShell(props: ParentProps) {
  const current = useSkillMarketSession()
  const location = useLocation()
  const links = () => [
    { href: "/skills", label: "全部技能", visible: true },
    { href: "/expert-packages", label: "专家包", visible: true },
    { href: "/announcements", label: "公告", visible: true },
    { href: "/personal", label: "我的空间", visible: Boolean(current.session()) },
    { href: "/admin", label: "管理后台", visible: current.reviewer() },
  ]

  return (
    <div class="market-shell">
      <header class="market-shell__header">
        <A class="market-shell__brand" href="/skills" aria-label="SkillHub 首页">
          <img
            class="market-shell__brand-mark"
            src={`${import.meta.env.BASE_URL ?? "/"}ruying-skillhub-mark.svg`}
            alt=""
            aria-hidden="true"
          />
          <span class="market-shell__wordmark">
            <strong>SkillHub</strong>
          </span>
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
          <A class="market-shell__submit" href="/submissions/new">
            <span aria-hidden="true">+</span> 发布 Skill
          </A>
          <Show
            when={!current.loading() && current.session()}
            fallback={
              <Show when={!current.loading()}>
                <button type="button" class="market-primary-action" onClick={() => current.login(location.pathname)}>
                  登录
                </button>
              </Show>
            }
          >
            {(session) => (
              <>
                <span class="market-shell__identity">
                  <strong class="type-body" data-identity-name>{session().user.displayName}</strong>
                  <small class="type-secondary machine-id" data-identity-id>{session().user.employeeID}</small>
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
