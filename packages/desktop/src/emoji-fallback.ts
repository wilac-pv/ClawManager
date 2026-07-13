const emojiSequence =
  /(?:\p{Regional_Indicator}{2}|[#*0-9](?:\uFE0F?\u20E3|\uFE0F)|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0E|\uFE0F|\p{Emoji_Modifier})?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:\uFE0E|\uFE0F|\p{Emoji_Modifier})?)*)/gu

export function needsEmojiFallback(platform: NodeJS.Platform, version: string) {
  // CoreText crashes in ImageIO while decoding Apple Color Emoji glyphs on macOS 26.3.
  return platform === "darwin" && (version === "26.3" || version.startsWith("26.3."))
}

export function safeEmojiText(text: string) {
  return text.replace(emojiSequence, ":emoji:")
}

export function installEmojiFallback(document: Document) {
  const view = document.defaultView
  if (!view) return () => {}

  const attributes = ["alt", "placeholder", "title", "value"]
  const observed = new WeakSet<Node>()

  const cleanAttribute = (element: Element, name: string) => {
    const value = element.getAttribute(name)
    if (!value) return
    const safe = safeEmojiText(value)
    if (safe !== value) element.setAttribute(name, safe)
  }

  const observer = new view.MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === "characterData") clean(record.target)
      record.addedNodes.forEach(clean)
      if (record.type === "attributes" && record.target instanceof view.Element && record.attributeName) {
        cleanAttribute(record.target, record.attributeName)
      }
    })
  })

  const observe = (root: Node) => {
    if (observed.has(root)) return
    observed.add(root)
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: attributes,
    })
  }

  const cleanElement = (element: Element) => {
    attributes.forEach((name) => cleanAttribute(element, name))
    if (!element.shadowRoot) return
    clean(element.shadowRoot)
    observe(element.shadowRoot)
  }

  const clean = (root: Node) => {
    if (root.nodeType === view.Node.TEXT_NODE) {
      const value = safeEmojiText(root.nodeValue ?? "")
      if (value !== root.nodeValue) root.nodeValue = value
      return
    }

    if (root instanceof view.Element) cleanElement(root)
    const walker = document.createTreeWalker(root, view.NodeFilter.SHOW_ELEMENT | view.NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === view.Node.TEXT_NODE) {
        const value = safeEmojiText(node.nodeValue ?? "")
        if (value !== node.nodeValue) node.nodeValue = value
        continue
      }
      if (node instanceof view.Element) cleanElement(node)
    }
  }

  const patchValue = (prototype: object) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
    if (!descriptor?.set) return () => {}
    const set = descriptor.set
    Object.defineProperty(prototype, "value", {
      ...descriptor,
      set(value: unknown) {
        set.call(this, safeEmojiText(String(value)))
      },
    })
    return () => Object.defineProperty(prototype, "value", descriptor)
  }

  const restoreInputValue = patchValue(view.HTMLInputElement.prototype)
  const restoreTextareaValue = patchValue(view.HTMLTextAreaElement.prototype)
  const attachShadowDescriptor = Object.getOwnPropertyDescriptor(view.Element.prototype, "attachShadow")
  const restoreAttachShadow = (() => {
    if (!attachShadowDescriptor || typeof attachShadowDescriptor.value !== "function") return () => {}
    const attachShadow = attachShadowDescriptor.value as Element["attachShadow"]
    Object.defineProperty(view.Element.prototype, "attachShadow", {
      ...attachShadowDescriptor,
      value(this: Element, init: ShadowRootInit) {
        const root = attachShadow.call(this, init)
        clean(root)
        observe(root)
        return root
      },
    })
    return () => Object.defineProperty(view.Element.prototype, "attachShadow", attachShadowDescriptor)
  })()

  clean(document.documentElement)
  observe(document.documentElement)

  const onInput = (event: Event) => {
    const target = event.target
    if (!(target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement)) return
    const value = safeEmojiText(target.value)
    if (value === target.value) return
    const start = target.selectionStart
    const end = target.selectionEnd
    const nextStart = typeof start === "number" ? safeEmojiText(target.value.slice(0, start)).length : null
    const nextEnd = typeof end === "number" ? safeEmojiText(target.value.slice(0, end)).length : null
    target.value = value
    if (nextStart !== null && nextEnd !== null) target.setSelectionRange(nextStart, nextEnd)
  }

  document.addEventListener("input", onInput, true)
  return () => {
    observer.disconnect()
    document.removeEventListener("input", onInput, true)
    restoreInputValue()
    restoreTextareaValue()
    restoreAttachShadow()
  }
}
