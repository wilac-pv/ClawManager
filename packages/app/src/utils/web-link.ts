import type { LinkReservation } from "@/context/platform"

type Popup = {
  location: { href: string }
  close(): void
}

export function createWebLinkReservation(open: (url: string, target: string) => Popup | null) {
  return (): LinkReservation | undefined => {
    const popup = open("", "_blank")
    if (!popup) return
    return {
      navigate: (url) => {
        popup.location.href = url
      },
      close: () => popup.close(),
    }
  }
}
