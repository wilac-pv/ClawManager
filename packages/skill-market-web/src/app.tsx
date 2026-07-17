import {
  installPrompt,
  SkillMarketDetail,
  SkillMarketList,
  SkillMarketProvider,
  type SkillMarketActions,
  type SkillKey,
} from "@opencode-ai/app/skill-market"
import { Navigate, Route, Router, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { Match, Show, Switch, createSignal, type ParentProps } from "solid-js"
import { AuditLog } from "./admin/audit"
import { ModerationQueue } from "./admin/queue"
import { ModerationReview } from "./admin/review"
import { RoleAdministration } from "./admin/roles"
import { SkillHubImport } from "./admin/skillhub"
import { copyText } from "./clipboard"
import { createSkillMarketControlDataSource, type SkillMarketControlDataSource } from "./control-data-source"
import { createRemoteSkillMarketDataSource } from "./data-source"
import {
  RequireAdmin,
  RequireReviewer,
  RequireSession,
  SkillMarketSessionProvider,
  useSkillMarketSession,
} from "./session"
import { resolveSkillMarketRuntime } from "./runtime-config"
import { MarketShell } from "./shell"
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
  const source = createRemoteSkillMarketDataSource(runtime.apiBaseUrl, {
    allowInsecurePrivateHttp: runtime.allowInsecurePrivateHttp,
  })
  const control = createSkillMarketControlDataSource(runtime.apiBaseUrl, {
    allowInsecurePrivateHttp: runtime.allowInsecurePrivateHttp,
    csrfToken,
  })
  const actions: SkillMarketActions = {
    kind: "web",
    copyPrompt: async (detail) => {
      if (await copyText(installPrompt(detail))) return
      throw new Error("Skill market install prompt could not be copied")
    },
    download: async (detail) => {
      const target = await source.download?.({ source: detail.source, id: detail.id })
      if (!target) throw new Error("Skill market download endpoint is unavailable")
      window.location.assign(target.url)
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
      <Route path="/skills" component={SkillListRoute} />
      <Route path="/skills/:source/:id" component={SkillDetailRoute} />
      <Route path="/submissions" component={() => <SubmissionListRoute source={control} />} />
      <Route path="/submissions/new" component={() => <SubmissionFormRoute source={control} />} />
      <Route path="/submissions/:id" component={() => <SubmissionDetailRoute source={control} />} />
      <Route path="/admin" component={() => <ReviewQueueRoute source={control} />} />
      <Route path="/admin/submissions/:id" component={() => <ReviewDetailRoute source={control} />} />
      <Route path="/admin/roles" component={() => <RoleAdministrationRoute source={control} />} />
      <Route path="/admin/audit" component={() => <AuditRoute source={control} />} />
      <Route path="/admin/skillhub" component={() => <SkillHubImportRoute source={control} />} />
      <Route path="*" component={() => <Navigate href="/skills" />} />
    </Router>
  )
}

function SubmissionListRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireSession>
      <SubmissionList source={props.source.submissions} />
    </RequireSession>
  )
}

function SubmissionFormRoute(props: { source: SkillMarketControlDataSource }) {
  const navigate = useNavigate()
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
  return (
    <RequireSession>
      <Show when={previousID()} fallback={<SubmissionForm source={props.source.submissions} onAccepted={accepted} />}>
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
                mode={
                  detail().status === "published"
                    ? { kind: "version", initial: detail().metadata }
                    : { kind: "create", initial: detail().metadata }
                }
                onAccepted={accepted}
              />
            )}
          </Match>
        </Switch>
      </Show>
    </RequireSession>
  )
}

function SubmissionDetailRoute(props: { source: SkillMarketControlDataSource }) {
  const params = useParams<{ id: string }>()
  return (
    <RequireSession>
      <SubmissionDetail submissionID={params.id} source={props.source.submissions} />
    </RequireSession>
  )
}

function ReviewQueueRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireReviewer>
      <ModerationQueue source={props.source.moderation} />
    </RequireReviewer>
  )
}

function ReviewDetailRoute(props: { source: SkillMarketControlDataSource }) {
  const params = useParams<{ id: string }>()
  return (
    <RequireReviewer>
      <ReviewDetailContent submissionID={params.id} source={props.source} />
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
      <RoleAdministration source={props.source.roles} />
    </RequireAdmin>
  )
}

function AuditRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireAdmin>
      <AuditLog source={props.source.audit} />
    </RequireAdmin>
  )
}

function SkillHubImportRoute(props: { source: SkillMarketControlDataSource }) {
  return (
    <RequireAdmin>
      <SkillHubImport source={props.source.skillhub} />
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

function SkillListRoute() {
  const navigate = useNavigate()
  return (
    <SkillMarketList
      onOpen={(key) => navigate(`/skills/${key.source}/${encodeURIComponent(key.id)}`)}
      submitHref={`${import.meta.env.BASE_URL}submissions/new`}
    />
  )
}

function SkillDetailRoute() {
  const params = useParams<{ source: string; id: string }>()
  const navigate = useNavigate()
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
  return <SkillMarketDetail skill={key} onBack={() => navigate("/skills")} />
}

function parseSkillKey(source: string, id: string): SkillKey | undefined {
  if (source !== "skillhub" && source !== "enterprise" && source !== "community") return undefined
  if (!id.trim()) return undefined
  return { source, id }
}
