import {
  installPrompt,
  SkillMarketDetail,
  SkillMarketList,
  SkillMarketProvider,
  type SkillMarketActions,
  type SkillKey,
} from "@opencode-ai/app/skill-market"
import type { SkillMarketControl } from "@opencode-ai/schema/skill-market-control"
import { Navigate, Route, Router, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { Match, Show, Switch, createSignal, type ParentProps } from "solid-js"
import { AnnouncementAdministration } from "./admin/announcements"
import { GroupAdministration } from "./admin/groups"
import { AuditLog } from "./admin/audit"
import { AdminLayout } from "./admin/layout"
import { ModerationQueue } from "./admin/queue"
import { ModerationReview } from "./admin/review"
import { RoleAdministration } from "./admin/roles"
import { SkillHubImport } from "./admin/skillhub"
import { AnnouncementCarousel } from "./announcements/carousel"
import { AnnouncementDetail } from "./announcements/detail"
import { AnnouncementHistory } from "./announcements/history"
import { copyText } from "./clipboard"
import { createSkillMarketControlDataSource, type SkillMarketControlDataSource } from "./control-data-source"
import { createRemoteSkillMarketDataSource } from "./data-source"
import { ExpertPackageDetail } from "./expert-packages/detail"
import { ExpertPackageList } from "./expert-packages/list"
import { FavoritesPage, useFavoriteActions } from "./favorites"
import { GroupDetail } from "./groups/detail"
import { GroupList } from "./groups/list"
import {
  RequireAdmin,
  RequireReviewer,
  RequireSession,
  SkillMarketSessionProvider,
  useSkillMarketSession,
} from "./session"
import { resolveSkillMarketRuntime, skillDetailUrl, skillPackageUrl } from "./runtime-config"
import { MarketShell } from "./shell"
import { MySpaceLayout } from "./space/layout"
import { PersonalTrash } from "./space/trash"
import { SubmissionDetail } from "./submissions/detail"
import { SubmissionForm } from "./submissions/form"
import { SubmissionList } from "./submissions/list"

export function App() {
  const [csrfToken, setCsrfToken] = createSignal<string>()
  const runtime = resolveSkillMarketRuntime(
    import.meta.env.VITE_SKILL_MARKET_API_URL,
    window.location.origin,
    import.meta.env.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP,
  )
  const publicSource = createRemoteSkillMarketDataSource(runtime.apiBaseUrl, {
    allowInsecurePrivateHttp: runtime.allowInsecurePrivateHttp,
  })
  const control = createSkillMarketControlDataSource(runtime.apiBaseUrl, {
    allowInsecurePrivateHttp: runtime.allowInsecurePrivateHttp,
    csrfToken,
  })
  const source = {
    ...publicSource,
    detail: (key: SkillKey, signal?: AbortSignal) =>
      key.source === "restricted" ? control.restricted.detail(key.id, signal) : publicSource.detail(key, signal),
    versions: (key: SkillKey, signal?: AbortSignal) =>
      key.source === "restricted" ? control.restricted.versions(key.id, signal) : publicSource.versions(key, signal),
  }
  const actions: SkillMarketActions = {
    kind: "web",
    prompt: (detail) =>
      detail.source === "restricted"
        ? `restricted-install:${detail.id}`
        : installPrompt(detail, {
            detailUrl: skillDetailUrl(window.location.origin, import.meta.env.BASE_URL, detail),
            downloadUrl: skillPackageUrl(runtime.apiBaseUrl, detail),
          }),
    copyPrompt: async (value) => {
      const prompt = value.startsWith("restricted-install:")
        ? await restrictedInstallPrompt(value.slice("restricted-install:".length), control)
        : value
      if (await copyText(prompt)) return
      throw new Error("Skill market install prompt could not be copied")
    },
    download: async (detail) => {
      if (detail.source === "restricted") return
      window.location.assign(skillPackageUrl(runtime.apiBaseUrl, detail))
    },
  }
  const Root = (props: ParentProps) => (
    <SkillMarketProvider source={source} actions={actions}>
      <SkillMarketSessionProvider
        source={control}
        basePath={import.meta.env.BASE_URL}
        onSessionChange={setCsrfToken}
      >
        <MarketShell>{props.children}</MarketShell>
      </SkillMarketSessionProvider>
    </SkillMarketProvider>
  )

  return (
    <Router base={import.meta.env.BASE_URL.replace(/\/$/, "")} root={Root}>
      <Route path="/skills" component={() => <SkillListRoute source={control} announcements={source.announcements} />} />
      <Route path="/skills/:source/:id" component={() => <SkillDetailRoute source={control} />} />
      <Route path="/announcements" component={() => <AnnouncementHistory source={source.announcements} />} />
      <Route
        path="/announcements/:id"
        component={() => {
          const params = useParams<{ id: string }>()
          return <AnnouncementDetail announcementID={params.id} source={source.announcements} />
        }}
      />
      <Route
        path="/expert-packages"
        component={() =>
          source.expertPackages ? (
            <ExpertPackageList source={source.expertPackages} />
          ) : (
            <ProtectedPlaceholder title="专家包暂不可用" description="当前市场数据源不支持专家包。" />
          )
        }
      />
      <Route
        path="/expert-packages/:slug"
        component={() => {
          const params = useParams<{ slug: string }>()
          return source.expertPackages ? (
            <ExpertPackageDetail
              slug={params.slug}
              source={source.expertPackages}
              detailUrl={(slug) =>
                new URL(
                  `${import.meta.env.BASE_URL}expert-packages/${encodeURIComponent(slug)}`,
                  window.location.origin,
                ).href
              }
            />
          ) : (
            <ProtectedPlaceholder title="专家包暂不可用" description="当前市场数据源不支持专家包。" />
          )
        }}
      />
      <Route
        path="/favorites"
        component={() => (
          <RequireSession>
            <MySpaceLayout>
              <FavoritesPage source={control.favorites} catalog={source} />
            </MySpaceLayout>
          </RequireSession>
        )}
      />
      <Route path="/submissions" component={() => <SubmissionListRoute source={control} />} />
      <Route path="/personal" component={() => <PersonalSpaceRoute source={control} />} />
      <Route path="/trash" component={() => <TrashRoute source={control} />} />
      <Route path="/submissions/new" component={() => <SubmissionFormRoute source={control} />} />
      <Route path="/submissions/:id" component={() => <SubmissionDetailRoute source={control} />} />
      <Route path="/groups" component={() => <GroupListRoute source={control} />} />
      <Route path="/groups/:id" component={() => <GroupDetailRoute source={control} />} />
      <Route path="/admin" component={() => <ReviewQueueRoute source={control} />} />
      <Route path="/admin/submissions/:id" component={() => <ReviewDetailRoute source={control} />} />
      <Route path="/admin/roles" component={() => <RoleAdministrationRoute source={control} />} />
      <Route path="/admin/audit" component={() => <AuditRoute source={control} />} />
      <Route path="/admin/skillhub" component={() => <SkillHubImportRoute source={control} />} />
      <Route path="/admin/announcements" component={() => <AnnouncementAdministrationRoute source={control} />} />
      <Route path="/admin/groups" component={() => <GroupAdministrationRoute source={control} />} />
      <Route path="*" component={() => <Navigate href="/skills" />} />
    </Router>
  )
}

function SubmissionListRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireSession>
      <MySpaceLayout>
        <SubmissionList source={props.source.submissions} target="company" />
      </MySpaceLayout>
    </RequireSession>
  )
}

function PersonalSpaceRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireSession>
      <MySpaceLayout>
        <SubmissionList source={props.source.submissions} target="personal" />
      </MySpaceLayout>
    </RequireSession>
  )
}

function TrashRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireSession>
      <MySpaceLayout>
        <PersonalTrash source={props.source.submissions} />
      </MySpaceLayout>
    </RequireSession>
  )
}

function SubmissionFormRoute(props: { source: SkillMarketControlDataSource }) {
  const navigate = useNavigate()
  const session = useSkillMarketSession()
  const [params] = useSearchParams()
  const previousID = () => {
    const value = params.from
    if (typeof value !== "string" || !/^sub_[a-zA-Z0-9_-]{8,64}$/.test(value)) return undefined
    return value
  }
  const previous = createQuery(() => ({
    queryKey: ["skill-market", "submission", "prefill", previousID()] as const,
    enabled: Boolean(previousID()),
    queryFn: ({ signal }) => {
      const submissionID = previousID()
      if (!submissionID) throw new Error("A valid previous submission is required")
      return props.source.submissions.detail(submissionID, signal)
    },
  }))
  const accepted = (submissionID: string) => navigate(`/submissions/${submissionID}`)
  const target = () =>
    (["personal", "groups", "department", "company"] as const).find((value) => value === params.target) ?? "company"
  return (
    <RequireSession>
      <MySpaceLayout>
        <Show
          when={previousID()}
          fallback={
            <SubmissionForm
              source={props.source.submissions}
              groups={props.source.groups}
              department={session.session()?.user.department}
              mode={{ kind: "create", target: target() }}
              onAccepted={accepted}
            />
          }
        >
          <Switch>
            <Match when={previous.isPending}>
              <ProtectedPlaceholder title="正在准备投稿" description="正在读取上一版本信息。" />
            </Match>
            <Match when={previous.error}>
              <ProtectedPlaceholder title="无法读取上一版本" description="请返回我的投稿后重试。" />
            </Match>
            <Match when={previous.data}>
              {(detail) => (
                <SubmissionForm
                  source={props.source.submissions}
                  groups={props.source.groups}
                  department={session.session()?.user.department}
                  mode={
                    detail().status === "published"
                      ? { kind: "version", initial: detail().metadata, target: detail().target, audience: detail().audience }
                      : { kind: "create", initial: detail().metadata, target: detail().target, audience: detail().audience }
                  }
                  onAccepted={accepted}
                />
              )}
            </Match>
          </Switch>
        </Show>
      </MySpaceLayout>
    </RequireSession>
  )
}

function SubmissionDetailRoute(props: { source: SkillMarketControlDataSource }) {
  const params = useParams<{ id: string }>()
  return (
    <RequireSession>
      <MySpaceLayout>
        <SubmissionDetail
          submissionID={params.id}
          source={props.source.submissions}
          groups={props.source.groups}
          department={useSkillMarketSession().session()?.user.department}
        />
      </MySpaceLayout>
    </RequireSession>
  )
}

function GroupListRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireSession>
      <MySpaceLayout>
        <GroupList source={props.source.groups} />
      </MySpaceLayout>
    </RequireSession>
  )
}

function GroupDetailRoute(props: { source: SkillMarketControlDataSource }) {
  const params = useParams<{ id: string }>()
  const session = useSkillMarketSession()
  return (
    <RequireSession>
      <MySpaceLayout>
        <GroupDetail
          groupID={params.id}
          source={props.source.groups}
          actor={session.session()?.user.employeeID ?? ""}
          admin={session.admin()}
        />
      </MySpaceLayout>
    </RequireSession>
  )
}

function ReviewQueueRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireReviewer>
      <AdminLayout>
        <ModerationQueue source={props.source.moderation} />
      </AdminLayout>
    </RequireReviewer>
  )
}

function ReviewDetailRoute(props: { source: SkillMarketControlDataSource }) {
  const params = useParams<{ id: string }>()
  return (
    <RequireReviewer>
      <AdminLayout>
        <ReviewDetailContent submissionID={params.id} source={props.source} />
      </AdminLayout>
    </RequireReviewer>
  )
}

function ReviewDetailContent(props: { submissionID: string; source: SkillMarketControlDataSource }) {
  const navigate = useNavigate()
  const session = useSkillMarketSession()
  return (
    <ModerationReview
      submissionID={props.submissionID}
      source={props.source.moderation}
      actor={session.session()?.user.employeeID ?? ""}
      admin={session.admin()}
      operations={props.source.moderation}
      onDecided={() => navigate("/admin")}
    />
  )
}

function RoleAdministrationRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireAdmin>
      <AdminLayout>
        <RoleAdministration source={props.source.roles} />
      </AdminLayout>
    </RequireAdmin>
  )
}

function AuditRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireAdmin>
      <AdminLayout>
        <AuditLog source={props.source.audit} />
      </AdminLayout>
    </RequireAdmin>
  )
}

function SkillHubImportRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireAdmin>
      <AdminLayout>
        <SkillHubImport source={props.source.skillhub} />
      </AdminLayout>
    </RequireAdmin>
  )
}

function AnnouncementAdministrationRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireAdmin>
      <AdminLayout>
        <AnnouncementAdministration source={props.source.announcements} />
      </AdminLayout>
    </RequireAdmin>
  )
}

function GroupAdministrationRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireAdmin>
      <AdminLayout>
        <GroupAdministration source={props.source.groups} />
      </AdminLayout>
    </RequireAdmin>
  )
}

function ProtectedPlaceholder(props: { title: string; description: string }) {
  return (
    <main class="market-placeholder">
      <h1>{props.title}</h1>
      <p>{props.description}</p>
    </main>
  )
}

function SkillListRoute(props: {
  source: SkillMarketControlDataSource
  announcements: Parameters<typeof AnnouncementCarousel>[0]["source"]
}) {
  const navigate = useNavigate()
  const favorite = useFavoriteActions(props.source.favorites)
  return (
    <>
      <AnnouncementCarousel source={props.announcements} />
      <SkillMarketList
        onOpen={(key) => navigate(`/skills/${key.source}/${encodeURIComponent(key.id)}`)}
        submitHref={`${import.meta.env.BASE_URL}submissions/new`}
        favorite={favorite}
      />
    </>
  )
}

function SkillDetailRoute(props: { source: SkillMarketControlDataSource }) {
  const params = useParams<{ source: string; id: string }>()
  const navigate = useNavigate()
  const favorite = useFavoriteActions(props.source.favorites)
  const key = parseSkillKey(params.source, params.id)
  if (!key) {
    return (
      <main class="ruying-skill-market">
        <div class="ruying-skill-market__state ruying-skill-market__state--error" role="alert">
          这个 Skill 地址无效。
          <button type="button" onClick={() => navigate("/skills")}>
            返回 Skill 市场
          </button>
        </div>
      </main>
    )
  }
  const detail = <SkillMarketDetail skill={key} onBack={() => navigate("/skills")} favorite={favorite} />
  if (key.source === "restricted") return <RequireSession>{detail}</RequireSession>
  return detail
}

function parseSkillKey(source: string, id: string): SkillKey | undefined {
  if (source !== "skillhub" && source !== "enterprise" && source !== "community" && source !== "restricted")
    return undefined
  if (!id.trim()) return undefined
  return { source, id }
}

async function restrictedInstallPrompt(publicationID: string, source: SkillMarketControlDataSource) {
  const [detail, grant] = await Promise.all([
    source.restricted.detail(publicationID),
    source.restricted.installGrant(publicationID),
  ])
  if (new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error("Skill market install grant expired")
  return installPrompt(detail, {
    detailUrl: skillDetailUrl(window.location.origin, import.meta.env.BASE_URL, detail),
    downloadUrl: grant.url,
  })
}
