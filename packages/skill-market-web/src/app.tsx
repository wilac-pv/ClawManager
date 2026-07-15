import {
  installPrompt,
  SkillMarketDetail,
  SkillMarketList,
  SkillMarketProvider,
  type SkillMarketActions,
  type SkillKey,
} from "@opencode-ai/app/skill-market"
import { Navigate, Route, Router, useNavigate, useParams } from "@solidjs/router"
import type { ParentProps } from "solid-js"
import { createRemoteSkillMarketDataSource } from "./data-source"

export function App() {
  const source = createRemoteSkillMarketDataSource(import.meta.env.VITE_SKILL_MARKET_API_URL)
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
      {props.children}
    </SkillMarketProvider>
  )

  return (
    <Router base={import.meta.env.BASE_URL.replace(/\/$/, "")} root={Root}>
      <Route path="/skills" component={SkillListRoute} />
      <Route path="/skills/:source/:id" component={SkillDetailRoute} />
      <Route path="*" component={() => <Navigate href="/skills" />} />
    </Router>
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
  if (source !== "skillhub" && source !== "enterprise") return
  if (!id.trim()) return
  return { source, id }
}
