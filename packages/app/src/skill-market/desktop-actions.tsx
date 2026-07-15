import type { SkillMarket } from "@opencode-ai/schema/skill-market"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDesktopSkillMarket, type DesktopOperation } from "./desktop-provider"
import type { SkillKey } from "./types"

export type DesktopActionState =
  | { type: "available" }
  | { type: "installing" }
  | { type: "installed"; version: string }
  | { type: "updating"; version: string }
  | { type: "update-available"; installed: string; available: string }
  | { type: "refresh-failed"; version: string }
  | { type: "delisted"; installed?: string }

export function DesktopSkillActions(props: { detail: SkillMarket.Detail }) {
  const market = useDesktopSkillMarket()
  const [dialog, setDialog] = createStore<{
    risk?: "install" | "update"
    riskAccepted: boolean
    uninstall: boolean
    error: string
  }>({ riskAccepted: false, uninstall: false, error: "" })
  const installed = () => market.item(props.detail)
  const state = () => desktopActionState(props.detail, installed(), market.pending(props.detail))
  const run = (operation: () => Promise<unknown>) => {
    setDialog("error", "")
    void operation().then(
      () => setDialog({ risk: undefined, riskAccepted: false, uninstall: false }),
      (error) => setDialog("error", market.errorMessage(error)),
    )
  }
  const mutate = (operation: "install" | "update") => {
    if (props.detail.risk !== "safe" && !dialog.riskAccepted) {
      setDialog({ risk: operation, riskAccepted: false })
      return
    }
    run(() => market[operation](props.detail, props.detail.risk !== "safe"))
  }

  return (
    <div class="ruying-skill-market__detail-actions">
      <Show when={state().type === "available"}>
        <button type="button" class="ruying-skill-market__primary-action" onClick={() => mutate("install")}>
          安装
        </button>
      </Show>
      <Show when={state().type === "installing"}>
        <button type="button" class="ruying-skill-market__primary-action" disabled>
          安装中…
        </button>
      </Show>
      <Show when={state().type === "update-available"}>
        <button type="button" class="ruying-skill-market__primary-action" onClick={() => mutate("update")}>
          升级
        </button>
      </Show>
      <Show when={state().type === "updating"}>
        <button type="button" class="ruying-skill-market__primary-action" disabled>
          升级中…
        </button>
      </Show>
      <Show when={state().type === "installed"}>
        <span class="ruying-skill-market__installed-state">已安装</span>
      </Show>
      <Show when={state().type === "refresh-failed"}>
        <span class="ruying-skill-market__load-failed">已安装，加载失败</span>
        <button
          type="button"
          disabled={market.pending(props.detail) === "refresh"}
          onClick={() => run(() => market.refresh(props.detail))}
        >
          {market.pending(props.detail) === "refresh" ? "加载中…" : "重试加载"}
        </button>
      </Show>
      <Show when={state().type === "delisted"}>
        <span class="ruying-skill-market__load-failed">此 Skill 已下架</span>
      </Show>
      <Show when={installed() !== undefined || props.detail.installedVersion !== undefined}>
        <button
          type="button"
          disabled={market.pending(props.detail) !== undefined}
          onClick={() => setDialog("uninstall", true)}
        >
          卸载
        </button>
      </Show>

      <Show when={dialog.risk}>
        <div class="ruying-skill-market__confirm" role="dialog" aria-modal="true" aria-label="风险确认">
          <strong>安装前请确认风险</strong>
          <p>{props.detail.riskReason ?? "该 Skill 尚未被标记为安全。"}</p>
          <div class="ruying-skill-market__confirm-reports">
            <For each={props.detail.securityReports}>{(report) => <p>{report.summary}</p>}</For>
          </div>
          <label>
            <input
              type="checkbox"
              checked={dialog.riskAccepted}
              onChange={(event) => setDialog("riskAccepted", event.currentTarget.checked)}
            />
            我已阅读并接受该 Skill 的风险
          </label>
          <div class="ruying-skill-market__confirm-actions">
            <button type="button" onClick={() => setDialog({ risk: undefined, riskAccepted: false })}>
              取消
            </button>
            <button
              type="button"
              class="ruying-skill-market__primary-action"
              disabled={!dialog.riskAccepted || market.pending(props.detail) !== undefined}
              onClick={() => dialog.risk && mutate(dialog.risk)}
            >
              {dialog.risk === "update" ? "确认风险并升级" : "确认风险并安装"}
            </button>
          </div>
        </div>
      </Show>

      <Show when={dialog.uninstall}>
        <div class="ruying-skill-market__confirm" role="dialog" aria-modal="true" aria-label="卸载确认">
          <strong>确认卸载 {props.detail.name}？</strong>
          <p>卸载后将从如影 Code 的可用 Skills 中移除。</p>
          <div class="ruying-skill-market__confirm-actions">
            <button type="button" onClick={() => setDialog("uninstall", false)}>
              取消
            </button>
            <button
              type="button"
              class="ruying-skill-market__danger-action"
              disabled={market.pending(props.detail) === "uninstall"}
              onClick={() => run(() => market.uninstall(props.detail))}
            >
              确认卸载
            </button>
          </div>
        </div>
      </Show>

      <Show when={dialog.error}>
        <span class="ruying-skill-market__action-error" role="alert">
          {dialog.error}
        </span>
      </Show>
    </div>
  )
}

export function DesktopInstalledActions(props: { item: SkillMarket.Installed }) {
  const market = useDesktopSkillMarket()
  const [state, setState] = createStore({ confirm: false, error: "" })
  const run = (operation: () => Promise<unknown>) => {
    setState("error", "")
    void operation().then(
      () => setState("confirm", false),
      (error) => setState("error", market.errorMessage(error)),
    )
  }

  return (
    <div class="ruying-skill-market__installed-actions">
      <Show when={props.item.loadState === "refresh-failed"}>
        <button
          type="button"
          aria-label={`重试加载 ${props.item.name}`}
          disabled={market.pending(props.item) === "refresh"}
          onClick={() => run(() => market.refresh(props.item))}
        >
          {market.pending(props.item) === "refresh" ? "加载中…" : "重试加载"}
        </button>
      </Show>
      <button
        type="button"
        class="ruying-skill-market__danger-action"
        aria-label={`卸载 ${props.item.name}`}
        onClick={() => setState("confirm", true)}
      >
        卸载
      </button>
      <Show when={state.confirm}>
        <div class="ruying-skill-market__confirm" role="dialog" aria-modal="true" aria-label="卸载确认">
          <strong>确认卸载 {props.item.name}？</strong>
          <div class="ruying-skill-market__confirm-actions">
            <button type="button" onClick={() => setState("confirm", false)}>
              取消
            </button>
            <button
              type="button"
              class="ruying-skill-market__danger-action"
              onClick={() => run(() => market.uninstall(props.item))}
            >
              确认卸载
            </button>
          </div>
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

export function desktopActionState(
  detail: SkillMarket.Detail,
  installed?: SkillMarket.Installed,
  pending?: DesktopOperation,
): DesktopActionState {
  if (pending === "install") return { type: "installing" }
  if (pending === "update")
    return { type: "updating", version: installed?.version ?? detail.installedVersion ?? detail.version }
  const version = installed?.version ?? detail.installedVersion
  if (detail.delisted) return { type: "delisted", installed: version }
  if (installed?.loadState === "refresh-failed") return { type: "refresh-failed", version: installed.version }
  if (installed?.updateAvailable || detail.updateAvailable) {
    return { type: "update-available", installed: version ?? detail.version, available: detail.version }
  }
  if (version) return { type: "installed", version }
  return { type: "available" }
}

export function skillKey(key: SkillKey) {
  return `${key.source}:${key.id}`
}
