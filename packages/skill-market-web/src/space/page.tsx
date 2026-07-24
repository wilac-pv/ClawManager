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
        <p class="space-page__eyebrow">{props.eyebrow}</p>
        <h1>{props.title}</h1>
        <p>{props.description}</p>
      </div>
      <div class="space-page__action">{props.action}</div>
    </header>
  )
}
