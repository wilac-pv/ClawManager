import { DialogBody, DialogHeader, DialogTitle, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, onCleanup, onMount, type Component, For, Show } from "solid-js"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { ModelTooltip } from "./model-tooltip"

type ModelState = ReturnType<typeof useLocal>["model"]

export const DialogSelectModelUnpaidV2: Component<{ model?: ModelState }> = (props) => {
  const local = useLocal()
  const model = props.model ?? local.model
  const dialog = useDialog()
  const language = useLanguage()
  const modelKey = (item: ReturnType<ModelState["list"]>[number]) => `${item.provider.id}:${item.id}`
  const currentKey = createMemo(() => {
    const c = model.current()
    return c ? `${c.provider.id}:${c.id}` : undefined
  })
  const isFree = (item: ReturnType<ModelState["list"]>[number]) =>
    item.provider.id === "opencode" && (!item.cost || item.cost.input === 0)

  const selectModel = (item: ReturnType<ModelState["list"]>[number]) => {
    model.set({ modelID: item.id, providerID: item.provider.id }, { recent: true })
    dialog.close()
  }

  // Focus starts on the dialog's close button, outside the list, so listen at the
  // document level while the dialog is mounted instead of on the list container.
  let listEl: HTMLDivElement | undefined
  onMount(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
      if (!listEl) return
      const buttons = Array.from(listEl.querySelectorAll<HTMLButtonElement>("button"))
      if (buttons.length === 0) return
      const index = document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1
      const next =
        index < 0 ? (e.key === "ArrowDown" ? 0 : buttons.length - 1) : index + (e.key === "ArrowDown" ? 1 : -1)
      buttons[(next + buttons.length) % buttons.length]?.focus()
      e.preventDefault()
    }
    document.addEventListener("keydown", handleKeyDown)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown))
  })

  return (
    <DialogV2 containerClass="!h-[min(calc(100vh_-_16px),480px)] !w-[min(calc(100vw_-_16px),560px)]">
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("dialog.model.select.title")}</DialogTitle>
      </DialogHeader>
      <div class="h-px w-full shrink-0 bg-v2-border-border-muted" />
      <DialogBody class="min-h-0 flex-1 gap-0">
        <ScrollView class="min-h-0 flex-1 w-full">
          <div ref={listEl} class="flex min-h-full flex-col">
            <div class="flex h-fit w-full flex-col items-start gap-0.5 px-3.5 pb-3.5 pt-3">
              <div class="flex h-8 w-full flex-none select-none flex-row items-center gap-2 self-stretch px-2.5 pb-2 pt-1">
                <div class="flex h-5 flex-none flex-row items-center p-0 font-[440] text-[13px] leading-5 tracking-[-0.04px] text-v2-text-text-faint [font-family:Inter,var(--font-family-sans)] [font-variant-numeric:tabular-nums] [font-variation-settings:'slnt'_0]">
                  {language.t("dialog.model.unpaid.freeModels.title")}
                </div>
              </div>
              <For each={model.list()}>
                {(item) => (
                  <TooltipV2
                    class="w-full"
                    placement="right-start"
                    gutter={6}
                    openDelay={0}
                    value={<ModelTooltip model={item} latest={item.latest} free={isFree(item)} v2 />}
                  >
                    <button
                      type="button"
                      class="flex w-full scroll-my-3.5 flex-row items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] font-[530] leading-5 tracking-[-0.04px] text-v2-text-text-base [font-family:Inter,var(--font-family-sans)] [font-variation-settings:'slnt'_0] hover:bg-v2-overlay-simple-overlay-hover focus:bg-v2-overlay-simple-overlay-hover focus:outline-none"
                      onClick={() => selectModel(item)}
                    >
                      <span class="min-w-0 truncate">{item.name}</span>
                      <Show when={isFree(item)}>
                        <Tag class="shrink-0">{language.t("model.tag.free")}</Tag>
                      </Show>
                      <Show when={item.latest}>
                        <Tag class="shrink-0">{language.t("model.tag.latest")}</Tag>
                      </Show>
                      <Show when={currentKey() === modelKey(item)}>
                        <Icon name="check" class="ml-auto size-4 shrink-0 text-v2-icon-icon-base" />
                      </Show>
                    </button>
                  </TooltipV2>
                )}
              </For>
            </div>
          </div>
        </ScrollView>
      </DialogBody>
    </DialogV2>
  )
}
