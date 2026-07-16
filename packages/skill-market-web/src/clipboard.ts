export async function copyText(
  value: string,
  adapters: {
    readonly legacy: (value: string) => boolean
    readonly modern?: (value: string) => Promise<void>
  } = {
    legacy: copyWithSelection,
    modern:
      typeof navigator === "undefined" || !navigator.clipboard?.writeText
        ? undefined
        : (value) => navigator.clipboard.writeText(value),
  },
) {
  if (adapters.legacy(value)) return true
  if (!adapters.modern) return false
  return adapters.modern(value).then(
    () => true,
    () => false,
  )
}

function copyWithSelection(value: string) {
  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") return false
  const target = document.createElement("textarea")
  target.value = value
  target.setAttribute("readonly", "")
  target.style.position = "fixed"
  target.style.opacity = "0"
  target.style.pointerEvents = "none"
  document.body.appendChild(target)
  target.select()
  try {
    return document.execCommand("copy")
  } finally {
    target.remove()
  }
}
