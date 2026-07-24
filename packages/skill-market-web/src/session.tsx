import { A, useLocation } from "@solidjs/router"
import { createMutation, createQuery, useQueryClient } from "@tanstack/solid-query"
import { Match, Switch, createContext, createEffect, type ParentProps, useContext } from "solid-js"
import type { SkillMarketControlDataSource } from "./control-data-source"

interface SessionProviderProps {
  readonly source: SkillMarketControlDataSource
  readonly basePath?: string
  readonly navigate?: (url: string) => void
  readonly onSessionChange?: (csrfToken: string | undefined) => void
}

const SessionContext = createContext<{
  session: () => Awaited<ReturnType<SkillMarketControlDataSource["auth"]["session"]>> | undefined
  loading: () => boolean
  error: () => unknown
  reviewer: () => boolean
  admin: () => boolean
  login: (returnTo: string) => void
  logout: () => Promise<void>
  refetch: () => Promise<unknown>
}>()

export function SkillMarketSessionProvider(props: ParentProps<SessionProviderProps>) {
  const client = useQueryClient()
  const session = createQuery(() => ({
    queryKey: ["skill-market", "session"] as const,
    queryFn: ({ signal }) => props.source.auth.session(signal),
    retry: false,
    staleTime: 30_000,
  }))
  const logout = createMutation(() => ({
    mutationFn: () => props.source.auth.logout(),
    onSuccess: () => client.setQueryData(["skill-market", "session"], null),
  }))

  createEffect(() => props.onSessionChange?.(session.data?.csrfToken))

  return (
    <SessionContext.Provider
      value={{
        session: () => session.data,
        loading: () => session.isPending,
        error: () => session.error,
        reviewer: () => session.data?.roles.some((role) => role === "reviewer" || role === "admin") ?? false,
        admin: () => session.data?.roles.includes("admin") ?? false,
        login: (returnTo) =>
          (props.navigate ?? ((url) => window.location.assign(url)))(
            props.source.auth.loginUrl(safeReturnTo(returnTo, props.basePath)),
          ),
        logout: () => logout.mutateAsync(),
        refetch: () => session.refetch(),
      }}
    >
      {props.children}
    </SessionContext.Provider>
  )
}

export function useSkillMarketSession() {
  const context = useContext(SessionContext)
  if (!context) throw new Error("SkillMarketSessionProvider is missing")
  return context
}

export function RequireSession(props: ParentProps) {
  return <SessionGuard>{props.children}</SessionGuard>
}

export function RequireReviewer(props: ParentProps) {
  return <SessionGuard role="reviewer">{props.children}</SessionGuard>
}

export function RequireAdmin(props: ParentProps) {
  return <SessionGuard role="admin">{props.children}</SessionGuard>
}

function SessionGuard(props: ParentProps<{ role?: "reviewer" | "admin" }>) {
  const current = useSkillMarketSession()
  const location = useLocation()
  const allowed = () => !props.role || (props.role === "reviewer" ? current.reviewer() : current.admin())
  return (
    <Switch fallback={props.children}>
      <Match when={current.loading()}>
        <GuardState status="status" title="正在检查登录状态…" />
      </Match>
      <Match when={!current.session()}>
        <GuardState title="登录后继续">
          <p>登录后可使用投稿与管理功能。</p>
          <button
            type="button"
            class="market-primary-action"
            onClick={() => current.login(`${location.pathname}${location.search}`)}
          >
            使用 GWM SSO 登录
          </button>
        </GuardState>
      </Match>
      <Match when={!allowed()}>
        <GuardState status="alert" title="没有访问权限">
          <p>当前账号没有访问此页面所需的角色。</p>
          <A href="/skills">返回 Skill 市场</A>
        </GuardState>
      </Match>
    </Switch>
  )
}

function GuardState(props: ParentProps<{ title: string; status?: "alert" | "status" }>) {
  return (
    <main class="market-guard-state" role={props.status}>
      <h1>{props.title}</h1>
      {props.children}
    </main>
  )
}

export function safeReturnTo(value: string, basePath = "/") {
  const base = "https://market.invalid"
  if (!URL.canParse(value, base)) return "/skills"
  const url = new URL(value, base)
  if (url.origin !== base || value.startsWith("//")) return "/skills"
  const normalizedBasePath = basePath === "/" ? "/" : `${basePath.replace(/\/+$/, "")}/`
  const pathname =
    normalizedBasePath !== "/" && normalizedBasePath.startsWith("/") && url.pathname.startsWith(normalizedBasePath)
      ? `/${url.pathname.slice(normalizedBasePath.length)}`
      : url.pathname
  const known = [
    /^\/skills(?:\/(?:skillhub|enterprise|community)\/[^/]+)?$/,
    /^\/announcements(?:\/ann_[a-zA-Z0-9_-]{8,64})?$/,
    /^\/expert-packages(?:\/[a-z0-9][a-z0-9-]{0,127})?$/,
    /^\/favorites$/,
    /^\/submissions(?:\/new|\/sub_[a-zA-Z0-9_-]{8,64})?$/,
    /^\/personal$/,
    /^\/admin(?:\/submissions\/sub_[a-zA-Z0-9_-]{8,64}|\/roles|\/audit|\/skillhub|\/announcements)?$/,
  ]
  if (!known.some((pattern) => pattern.test(pathname))) return "/skills"
  return `${pathname}${url.search}`
}
