import { expect, test } from "bun:test"
import { createWebLinkReservation } from "./web-link"

test("web link reservation opens a blank tab synchronously and navigates it later", () => {
  const events: string[] = []
  const popup = {
    location: { href: "" },
    close: () => events.push("close"),
  }
  const reserve = createWebLinkReservation((_url, target) => {
    events.push(`open:${target}`)
    return popup
  })

  const reserved = reserve()
  expect(events).toEqual(["open:_blank"])
  reserved?.navigate("https://sso.example/login")
  expect(popup.location.href).toBe("https://sso.example/login")
  reserved?.close()
  expect(events).toEqual(["open:_blank", "close"])
})

test("web link reservation reports popup blocking without a url", () => {
  const reserve = createWebLinkReservation(() => null)

  expect(reserve()).toBeUndefined()
})
