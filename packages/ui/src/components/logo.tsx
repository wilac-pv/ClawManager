import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        data-slot="logo-logo-mark-shadow"
        d="M3 3.3H8V5.7H3V3.3ZM3 11.3H8V12.7H3V11.3Z"
        fill="var(--icon-weak-base)"
      />
      <path
        data-slot="logo-logo-mark-ruying"
        fill-rule="evenodd"
        d="M1.5 2H9.5V7H8V8H10V9.5H1V8H3V7H1.5V2ZM3 3.3V4H8V3.3H3ZM3 5V5.7H8V5H3ZM1.5 10H9.5V14H7V18H4.7V14H1.5V10ZM3 11.3V12.7H8V11.3H3ZM2.7 14.5L4.3 15.3L2.7 18L1.1 17.2L2.7 14.5ZM7.5 14.5L10 17L8.6 18.4L6.2 15.8L7.5 14.5ZM13.3 2.3L15.3 3.4C14.3 5.4 13.2 6.8 11.2 8.3L9.9 6.6C11.5 5.4 12.5 4.2 13.3 2.3ZM13.7 7.7L15.7 8.8C14.5 11.2 13.1 12.9 10.8 14.5L9.6 12.7C11.5 11.4 12.7 9.9 13.7 7.7ZM14 13L16 14.1C14.6 16.8 13 18.4 10.5 20L9.3 18.2C11.4 16.8 12.8 15.4 14 13Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 80H20V40H60V80Z" fill="var(--icon-base)" />
      <path d="M60 20H20V80H60V20ZM80 100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        <path d="M18 30H6V18H18V30Z" fill="var(--icon-weak-base)" />
        <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill="var(--icon-base)" />
        <path d="M48 30H36V18H48V30Z" fill="var(--icon-weak-base)" />
        <path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" fill="var(--icon-base)" />
        <path d="M84 24V30H66V24H84Z" fill="var(--icon-weak-base)" />
        <path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill="var(--icon-base)" />
        <path d="M108 36H96V18H108V36Z" fill="var(--icon-weak-base)" />
        <path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" fill="var(--icon-base)" />
        <path d="M144 30H126V18H144V30Z" fill="var(--icon-weak-base)" />
        <path d="M144 12H126V30H144V36H120V6H144V12Z" fill="var(--icon-strong-base)" />
        <path d="M168 30H156V18H168V30Z" fill="var(--icon-weak-base)" />
        <path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" fill="var(--icon-strong-base)" />
        <path d="M198 30H186V18H198V30Z" fill="var(--icon-weak-base)" />
        <path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" fill="var(--icon-strong-base)" />
        <path d="M234 24V30H216V24H234Z" fill="var(--icon-weak-base)" />
        <path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
