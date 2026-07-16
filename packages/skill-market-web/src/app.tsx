import {
  installPrompt,
  SkillMarketDetail,
  SkillMarketList,
  SkillMarketProvider,
  type SkillMarketActions,
  type SkillKey,
} from "@opencode-ai/app/skill-market"
import { Navigate, Route, Router, useNavigate, useParams } from "@solidjs/router"
import { createSignal, type ParentProps } from "solid-js"
import { createSkillMarketControlDataSource } from "./control-data-source"
import { createRemoteSkillMarketDataSource } from "./data-source"
import { RequireAdmin, RequireReviewer, RequireSession, SkillMarketSessionProvider } from "./session"
import { MarketShell } from "./shell"

export function App() {
  const [csrfToken, setCsrfToken] = createSignal<string>()
  const source = createRemoteSkillMarketDataSource(import.meta.env.VITE_SKILL_MARKET_API_URL, {
    allowInsecurePrivateHttp: import.meta.env.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP === "true",
  })
  const control = createSkillMarketControlDataSource(import.meta.env.VITE_SKILL_MARKET_API_URL, {
    allowInsecurePrivateHttp: import.meta.env.VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP === "true",
    csrfToken,
  })
  const actions: SkillMarketActions = {
    kind: "web",
    copyPrompt: async (detail) => navigator.clipboard.writeText(installPrompt(detail)),
    download: async (detail) => {
      const target = await source.download?.({ source: detail.source, id: detail.id })
      if (!target) throw new Error("Skill market download endpoint is unavailable")
      window.location.assign(target.url)
    },
  }
  const Root = (props: ParentProps) => (
    <SkillMarketProvider source={source} actions={actions}>
      <SkillMarketSessionProvider source={control} onSessionChange={setCsrfToken}>
        <MarketShell>{props.children}</MarketShell>
      </SkillMarketSessionProvider>
    </SkillMarketProvider>
  )

  return (
    <Router base={import.meta.env.BASE_URL.replace(/\/$/, "")} root={Root}>
      <Route path="/skills" component={SkillListRoute} />
      <Route path="/skills/:source/:id" component={SkillDetailRoute} />
      <Route path="/submissions" component={SubmissionHomeRoute} />
      <Route path="/submissions/new" component={SubmissionHomeRoute} />
      <Route path="/submissions/:id" component={SubmissionHomeRoute} />
      <Route path="/admin" component={ReviewHomeRoute} />
      <Route path="/admin/submissions/:id" component={ReviewHomeRoute} />
      <Route path="/admin/roles" component={RoleHomeRoute} />
      <Route path="/admin/audit" component={RoleHomeRoute} />
      <Route path="*" component={() => <Navigate href="/skills" />} />
    </Router>
  )
}

function SubmissionHomeRoute() {
  return (
    <RequireSession>
      <ProtectedPlaceholder title="我的投稿" description="投稿功能正在加载。" />
    </RequireSession>
  )
}

function ReviewHomeRoute() {
  return (
    <RequireReviewer>
      <ProtectedPlaceholder title="管理后台" description="审核功能正在加载。" />
    </RequireReviewer>
  )
}

function RoleHomeRoute() {
  return (
    <RequireAdmin>
      <ProtectedPlaceholder title="Admin 管理" description="管理功能正在加载。" />
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
  return <SkillMarketList onOpen={(key) => navigate(`/skills/${key.source}/${encodeURIComponent(key.id)}`)} />
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
  if (source !== "skillhub" && source !== "enterprise") return undefined
  if (!id.trim()) return undefined
  return { source, id }
}
