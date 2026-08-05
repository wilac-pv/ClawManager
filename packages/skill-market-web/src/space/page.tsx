import type { JSX } from "solid-js"

export function SpacePageHeader(props: {
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly action: JSX.Element
}) {
  return (
    <header class="space-page__header">
      <div>
        <p class="space-page__eyebrow type-label">{props.eyebrow}</p>
        <h1 class="type-page-title">{props.title}</h1>
        <p class="type-secondary">{props.description}</p>
      </div>
      <div class="space-page__action">{props.action}</div>
    </header>
  )
}
