import type { SkillMarketDataSource } from "@opencode-ai/app/skill-market"
import { A } from "@solidjs/router"
import { createQuery } from "@tanstack/solid-query"
import { For, Show, createSignal } from "solid-js"
import { copyText } from "../clipboard"
import { expertLabel, sceneLabel } from "./list"

type ExpertPackageSource = NonNullable<SkillMarketDataSource["expertPackages"]>

export function ExpertPackageDetail(props: {
  slug: string
  source: ExpertPackageSource
  detailUrl: (slug: string) => string
}) {
  const [copied, setCopied] = createSignal(false)
  const detail = createQuery(() => ({
    queryKey: ["skill-market", "expert-package", props.slug] as const,
    queryFn: ({ signal }) => props.source.detail(props.slug, signal),
  }))
  const prompt = () => {
    const value = detail.data
    if (!value) return ""
    return `请安装并使用这个如影 SkillHub 专家包：${value.displayName}
内网详情：${props.detailUrl(value.slug)}
包含 Skill：${value.skillSlugs.join("、")}
要求：仅使用上述如影内网市场提供的详情和下载地址，不要从外网下载安装。`
  }
  const copy = async () => {
    setCopied(await copyText(prompt()))
  }
  return (
    <main class="expert-package-detail">
      <Show when={detail.isPending}>
        <div class="market-placeholder" role="status">
          正在加载专家包…
        </div>
      </Show>
      <Show when={detail.isError}>
        <div class="market-placeholder" role="alert">
          这个专家包不存在或暂不可用。
        </div>
      </Show>
      <Show when={detail.data}>
        {(value) => (
          <>
            <nav class="expert-package-detail__breadcrumb">
              <A href="/expert-packages">专家包</A>
              <span>/</span>
              <span>{value().displayName}</span>
            </nav>
            <header class="expert-package-detail__header">
              <div class="expert-package-detail__icon">{value().displayName.trim().charAt(0)}</div>
              <div>
                <span>{expertLabel(value().scene)}</span>
                <h1>{value().displayName}</h1>
                <p>{value().summary}</p>
                <div>
                  <span>{sceneLabel(value().scene)}</span>
                  <span>{value().skillCount} 个 Skill 模块</span>
                  <span>如影 SkillHub 专家包</span>
                </div>
              </div>
            </header>
            <div class="expert-package-detail__layout">
              <section class="expert-package-detail__content">
                <WorkflowContent value={value().content} />
              </section>
              <aside>
                <p>将安装 Prompt 发送给如影 Code，即可按工作流安装包含的 Skill。</p>
                <button type="button" class="market-primary-action" onClick={() => void copy()}>
                  {copied() ? "已复制安装 Prompt" : "复制安装 Prompt"}
                </button>
                <h2>包含的 Skill</h2>
                <ul>
                  <For each={value().skillSlugs}>
                    {(slug) => (
                      <li>
                        <A href={`/skills?q=${encodeURIComponent(slug)}`}>{slug}</A>
                      </li>
                    )}
                  </For>
                </ul>
              </aside>
            </div>
          </>
        )}
      </Show>
    </main>
  )
}

function WorkflowContent(props: { value: string }) {
  const lines = () => props.value.split(/\r?\n/).filter((line) => line.trim())
  return (
    <div class="expert-package-detail__workflow">
      <For each={lines()}>
        {(line) =>
          line.startsWith("### ") ? (
            <h3>{line.slice(4)}</h3>
          ) : line.startsWith("## ") ? (
            <h2>{line.slice(3)}</h2>
          ) : line.startsWith("# ") ? (
            <h2>{line.slice(2)}</h2>
          ) : line.startsWith("- ") ? (
            <p class="expert-package-detail__step">• {line.slice(2)}</p>
          ) : (
            <p>{line.replace(/\*\*/g, "")}</p>
          )
        }
      </For>
    </div>
  )
}
