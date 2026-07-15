import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { createQuery } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { MarketMarkdown } from "./markdown"
import { useSkillMarket } from "./provider"
import type { SkillKey, SkillMarketActions } from "./types"

type DetailTab = "overview" | "versions" | "security"

const tabs = [
  { id: "overview", label: "概述" },
  { id: "versions", label: "版本" },
  { id: "security", label: "安全报告" },
] as const

export function SkillMarketDetail(props: { skill: SkillKey; onBack: () => void }) {
  const market = useSkillMarket()
  const [state, setState] = createStore({ tab: "overview" as DetailTab, iconFailed: false })
  const tabRefs: HTMLButtonElement[] = []
  const detail = createQuery(() => ({
    queryKey: ["skill-market", "detail", props.skill.source, props.skill.id] as const,
    queryFn: ({ signal }) => market.source.detail(props.skill, signal),
  }))
  const versions = createQuery(() => ({
    queryKey: ["skill-market", "versions", props.skill.source, props.skill.id] as const,
    queryFn: ({ signal }) => market.source.versions(props.skill, signal),
    enabled: state.tab === "versions" && detail.data !== undefined,
  }))

  const selectTab = (tab: DetailTab, index: number) => {
    setState("tab", tab)
    tabRefs[index]?.focus()
  }

  return (
    <main class="ruying-skill-market ruying-skill-market--detail">
      <Show
        when={detail.data}
        keyed
        fallback={
          <Show
            when={detail.isError}
            fallback={
              <div class="ruying-skill-market__state" role="status">
                正在加载 Skill 详情…
              </div>
            }
          >
            <div class="ruying-skill-market__state ruying-skill-market__state--error" role="alert">
              这个 Skill 不存在或已下架，返回市场查看其他内容。
              <button type="button" onClick={props.onBack}>
                返回 Skill 市场
              </button>
            </div>
          </Show>
        }
      >
        {(record) => (
          <div class="ruying-skill-market__detail-shell">
            <nav class="ruying-skill-market__breadcrumb" aria-label="面包屑">
              <button type="button" onClick={props.onBack}>
                Skills
              </button>
              <span aria-hidden="true">/</span>
              <span>{record.name}</span>
            </nav>

            <Show when={record.delisted}>
              <div class="ruying-skill-market__delisted" role="status">
                此 Skill 已从来源下架
              </div>
            </Show>

            <header class="ruying-skill-market__detail-header">
              <div class="ruying-skill-market__detail-icon">
                <Show
                  when={record.iconUrl && !state.iconFailed ? record.iconUrl : undefined}
                  fallback={<span>{record.name.trim().charAt(0).toUpperCase() || "S"}</span>}
                >
                  {(url) => (
                    <img src={url()} alt={`${record.name} 图标`} onError={() => setState("iconFailed", true)} />
                  )}
                </Show>
              </div>
              <div class="ruying-skill-market__detail-intro">
                <div class="ruying-skill-market__detail-title">
                  <h1>{record.name}</h1>
                  <span class={`ruying-skill-market__risk ruying-skill-market__risk--${record.risk}`}>
                    {riskLabel(record.risk)}
                  </span>
                </div>
                <p>{record.description}</p>
                <div class="ruying-skill-market__detail-chips">
                  <span>v{record.version}</span>
                  <span>{record.source === "enterprise" ? "企业精选" : "SkillHub"}</span>
                  <For each={record.categories}>{(category) => <span>{category}</span>}</For>
                  <Show when={record.requiresApiKey}>
                    <span>需要 API Key</span>
                  </Show>
                </div>
              </div>
              <DetailActions detail={record} actions={market.actions} />
            </header>

            <div class="ruying-skill-market__detail-layout">
              <section class="ruying-skill-market__detail-main">
                <div class="ruying-skill-market__detail-tabs" role="tablist" aria-label="Skill 详情">
                  <For each={tabs}>
                    {(tab, index) => (
                      <button
                        ref={(element) => {
                          tabRefs[index()] = element
                        }}
                        type="button"
                        role="tab"
                        id={`skill-market-tab-${tab.id}`}
                        aria-controls={`skill-market-panel-${tab.id}`}
                        aria-selected={state.tab === tab.id}
                        tabIndex={state.tab === tab.id ? 0 : -1}
                        onClick={() => setState("tab", tab.id)}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowRight") {
                            event.preventDefault()
                            selectTab(tabs[(index() + 1) % tabs.length].id, (index() + 1) % tabs.length)
                            return
                          }
                          if (event.key === "ArrowLeft") {
                            event.preventDefault()
                            const previous = (index() - 1 + tabs.length) % tabs.length
                            selectTab(tabs[previous].id, previous)
                            return
                          }
                          if (event.key === "Home") {
                            event.preventDefault()
                            selectTab(tabs[0].id, 0)
                            return
                          }
                          if (event.key === "End") {
                            event.preventDefault()
                            selectTab(tabs.at(-1)?.id ?? "security", tabs.length - 1)
                          }
                        }}
                      >
                        {tab.label}
                      </button>
                    )}
                  </For>
                </div>

                <Show when={state.tab === "overview"}>
                  <div
                    id="skill-market-panel-overview"
                    role="tabpanel"
                    aria-labelledby="skill-market-tab-overview"
                    class="ruying-skill-market__detail-panel"
                  >
                    <MarketMarkdown value={record.readme} />
                  </div>
                </Show>
                <Show when={state.tab === "versions"}>
                  <div
                    id="skill-market-panel-versions"
                    role="tabpanel"
                    aria-labelledby="skill-market-tab-versions"
                    class="ruying-skill-market__detail-panel"
                  >
                    <Show when={!versions.isPending} fallback={<div role="status">正在加载版本记录…</div>}>
                      <div class="ruying-skill-market__versions">
                        <For each={versions.data ?? record.versions}>
                          {(version) => (
                            <article>
                              <strong>{version.version}</strong>
                              <span>{formatDate(version.publishedAt)}</span>
                              <code>{version.sha256}</code>
                              <span>{formatBytes(version.size)}</span>
                            </article>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
                <Show when={state.tab === "security"}>
                  <div
                    id="skill-market-panel-security"
                    role="tabpanel"
                    aria-labelledby="skill-market-tab-security"
                    class="ruying-skill-market__detail-panel"
                  >
                    <Show when={record.riskReason}>
                      <p class={`ruying-skill-market__risk-reason ruying-skill-market__risk--${record.risk}`}>
                        {record.riskReason}
                      </p>
                    </Show>
                    <Show
                      when={record.securityReports.length > 0}
                      fallback={
                        <div class="ruying-skill-market__empty">
                          <strong>暂无安全报告</strong>
                        </div>
                      }
                    >
                      <div class="ruying-skill-market__security-reports">
                        <For each={record.securityReports}>
                          {(report) => (
                            <article>
                              <div>
                                <strong>{report.provider}</strong>
                                <span class={`ruying-skill-market__risk ruying-skill-market__risk--${report.verdict}`}>
                                  {riskLabel(report.verdict)}
                                </span>
                              </div>
                              <p>{report.summary}</p>
                              <Show when={report.reportUrl}>
                                {(url) => (
                                  <a href={url()} target="_blank" rel="noopener noreferrer">
                                    查看完整报告
                                  </a>
                                )}
                              </Show>
                            </article>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </section>

              <aside class="ruying-skill-market__detail-aside" aria-label="Skill 信息">
                <dl>
                  <div>
                    <dt>作者</dt>
                    <dd>
                      <Author detail={record} />
                    </dd>
                  </div>
                  <div>
                    <dt>许可证</dt>
                    <dd>{record.license ?? "未声明"}</dd>
                  </div>
                  <div>
                    <dt>更新时间</dt>
                    <dd>{formatDate(record.updatedAt)}</dd>
                  </div>
                  <div>
                    <dt>下载量</dt>
                    <dd>{new Intl.NumberFormat("zh-CN").format(record.downloads)}</dd>
                  </div>
                  <div>
                    <dt>综合评分</dt>
                    <dd>{record.score.toFixed(1)}</dd>
                  </div>
                  <div>
                    <dt>包大小</dt>
                    <dd>{formatBytes(record.package.size)}</dd>
                  </div>
                </dl>
                <a href={record.sourceUrl} target="_blank" rel="noopener noreferrer">
                  查看原始来源
                </a>
              </aside>
            </div>
          </div>
        )}
      </Show>
    </main>
  )
}

function DetailActions(props: { detail: SkillMarket.Detail; actions: SkillMarketActions }) {
  const [state, setState] = createStore({ pending: false, confirmRisk: false, confirmed: false, error: "" })
  const request = createMemo<SkillMarket.InstallRequest>(() => ({
    source: props.detail.source,
    id: props.detail.id,
    version: props.detail.version,
    sha256: props.detail.package.sha256,
    riskConfirmed: props.detail.risk === "safe" ? undefined : true,
  }))

  const run = async (operation: () => Promise<unknown>) => {
    setState({ pending: true, error: "" })
    return operation().then(
      () => setState({ pending: false, confirmRisk: false }),
      () => setState({ pending: false, error: "操作失败，请重试。" }),
    )
  }

  const install = () => {
    if (props.actions.kind !== "desktop") return
    if (props.detail.risk !== "safe" && !state.confirmed) {
      setState("confirmRisk", true)
      return
    }
    void run(() => (props.actions.kind === "desktop" ? props.actions.install(request()) : Promise.resolve()))
  }

  return (
    <div class="ruying-skill-market__detail-actions">
      <Show when={props.actions.kind === "web"}>
        <button
          type="button"
          onClick={() => props.actions.kind === "web" && void props.actions.copyPrompt(props.detail)}
        >
          复制安装 Prompt
        </button>
        <button
          type="button"
          class="ruying-skill-market__primary-action"
          onClick={() => props.actions.kind === "web" && void props.actions.download(props.detail)}
        >
          下载 ZIP
        </button>
      </Show>
      <Show when={props.actions.kind === "desktop" && !props.detail.delisted && !props.detail.installedVersion}>
        <button type="button" class="ruying-skill-market__primary-action" disabled={state.pending} onClick={install}>
          {state.pending ? "安装中…" : "安装"}
        </button>
      </Show>
      <Show when={props.actions.kind === "desktop" && props.detail.updateAvailable}>
        <button
          type="button"
          class="ruying-skill-market__primary-action"
          disabled={state.pending}
          onClick={() => {
            if (props.actions.kind !== "desktop") return
            void run(() => (props.actions.kind === "desktop" ? props.actions.update(request()) : Promise.resolve()))
          }}
        >
          更新
        </button>
      </Show>
      <Show when={props.actions.kind === "desktop" && props.detail.installedVersion}>
        <button
          type="button"
          disabled={state.pending}
          onClick={() => {
            if (props.actions.kind !== "desktop") return
            void run(() =>
              props.actions.kind === "desktop" ? props.actions.uninstall(props.detail) : Promise.resolve(),
            )
          }}
        >
          卸载
        </button>
      </Show>
      <Show when={state.confirmRisk}>
        <div class="ruying-skill-market__risk-confirm" role="dialog" aria-label="风险确认">
          <strong>安装前请确认风险</strong>
          <p>{props.detail.riskReason ?? "该 Skill 尚未被标记为安全。"}</p>
          <label>
            <input
              type="checkbox"
              checked={state.confirmed}
              onChange={(event) => setState("confirmed", event.currentTarget.checked)}
            />
            我已阅读并理解安全报告
          </label>
          <button type="button" disabled={!state.confirmed || state.pending} onClick={install}>
            确认风险并安装
          </button>
        </div>
      </Show>
      <Show when={state.error}>
        <span class="ruying-skill-market__action-error" role="alert">
          {state.error}
        </span>
      </Show>
    </div>
  )
}

function Author(props: { detail: SkillMarket.Detail }) {
  return (
    <Show when={props.detail.author.url} fallback={props.detail.author.name}>
      {(url) => (
        <a href={url()} target="_blank" rel="noopener noreferrer">
          {props.detail.author.name}
        </a>
      )}
    </Show>
  )
}

export function installPrompt(detail: SkillMarket.Detail) {
  return `请安装并使用这个 Skill：${detail.name}\n详情：${detail.publicDetailUrl}\n来源：${detail.sourceUrl}\n版本：${detail.version}\nSHA-256：${detail.package.sha256}`
}

function riskLabel(risk: SkillMarket.Risk) {
  if (risk === "safe") return "安全"
  if (risk === "warning") return "注意"
  if (risk === "danger") return "高风险"
  return "待检测"
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value))
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
