import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { useNavigate, useParams } from "@solidjs/router"
import { createMemo, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import {
  createDesktopSkillMarket,
  DesktopSkillMarketProvider,
  SkillMarketDetail,
  SkillMarketList,
  SkillMarketProvider,
  type SkillKey,
} from "@/skill-market"

export function SkillMarketRoute() {
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const params = useParams<{ source?: string; id?: string }>()
  const navigate = useNavigate()
  const market = createMemo(() => createDesktopSkillMarket(serverSDK().client))
  const requestedDetail = () => params.source !== undefined || params.id !== undefined
  const key = createMemo(() => parseSkillKey(params.source, params.id))
  const back = () => {
    if (window.history.length > 1) {
      navigate(-1)
      return
    }
    navigate("/skills")
  }

  return (
    <SkillMarketProvider source={market().source} actions={market().actions}>
      <DesktopSkillMarketProvider translate={(key) => language.t(key)}>
        <div class="size-full min-h-0 overflow-hidden">
          <Show
            when={requestedDetail()}
            fallback={
              <SkillMarketList
                onOpen={(value) => navigate(`/skills/${value.source}/${encodeURIComponent(value.id)}`)}
              />
            }
          >
            <Show
              when={key()}
              keyed
              fallback={
                <main class="ruying-skill-market">
                  <div class="ruying-skill-market__state ruying-skill-market__state--error" role="alert">
                    这个 Skill 地址无效或已下架。
                    <button type="button" onClick={() => navigate("/skills")}>
                      返回 Skill 市场
                    </button>
                  </div>
                </main>
              }
            >
              {(value) => <SkillMarketDetail skill={value} onBack={back} />}
            </Show>
          </Show>
        </div>
      </DesktopSkillMarketProvider>
    </SkillMarketProvider>
  )
}

export function parseSkillKey(source?: string, id?: string): SkillKey | undefined {
  if ((source !== "skillhub" && source !== "enterprise") || !id) return
  const decoded = decodeSkillID(id)
  if (!decoded) return
  return { source: source satisfies SkillMarket.Source, id: decoded }
}

function decodeSkillID(id: string) {
  try {
    return decodeURIComponent(id)
  } catch {
    return
  }
}
