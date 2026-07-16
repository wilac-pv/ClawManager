import { expect, test } from "bun:test"
import { copyText } from "./clipboard"

test("copies through the synchronous private HTTP fallback before the Clipboard API", async () => {
  const legacy: string[] = []
  const modern: string[] = []
  expect(
    await copyText("install prompt", {
      legacy: (value) => {
        legacy.push(value)
        return true
      },
      modern: async (value) => {
        modern.push(value)
      },
    }),
  ).toBe(true)
  expect(legacy).toEqual(["install prompt"])
  expect(modern).toEqual([])
})

test("uses the Clipboard API after the private HTTP fallback declines", async () => {
  const modern: string[] = []
  expect(
    await copyText("install prompt", {
      legacy: () => false,
      modern: async (value) => {
        modern.push(value)
      },
    }),
  ).toBe(true)
  expect(modern).toEqual(["install prompt"])
})

test("reports failure when neither copy mechanism succeeds", async () => {
  expect(
    await copyText("install prompt", {
      legacy: () => false,
      modern: async () => Promise.reject(new Error("denied")),
    }),
  ).toBe(false)
})
