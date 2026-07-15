import DOMPurify from "dompurify"
import { marked } from "marked"
import { createMemo } from "solid-js"

const tags = [
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]

export function MarketMarkdown(props: { value: string }) {
  const html = createMemo(() => {
    if (!DOMPurify.isSupported) return ""
    const clean = DOMPurify.sanitize(marked.parse(props.value) as string, {
      ALLOWED_TAGS: tags,
      ALLOWED_ATTR: ["alt", "href", "src", "title"],
      ALLOW_UNKNOWN_PROTOCOLS: false,
      FORBID_CONTENTS: ["iframe", "script", "style"],
    })
    const template = document.createElement("template")
    template.innerHTML = clean
    template.content.querySelectorAll("a").forEach((anchor) => {
      if (!anchor.getAttribute("href")?.startsWith("https://")) {
        anchor.removeAttribute("href")
        return
      }
      anchor.target = "_blank"
      anchor.rel = "noopener noreferrer"
    })
    template.content.querySelectorAll("img").forEach((image) => {
      if (image.src.startsWith("https://")) return
      image.remove()
    })
    return template.innerHTML
  })

  return <div class="ruying-skill-market__markdown" innerHTML={html()} />
}
