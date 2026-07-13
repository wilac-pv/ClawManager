import { expect, test } from "bun:test"
import { Window } from "happy-dom"
import { installEmojiFallback, needsEmojiFallback, safeEmojiText } from "./emoji-fallback"

test("enables the emoji fallback only for the affected macOS release", () => {
  expect(needsEmojiFallback("darwin", "26.3.0")).toBe(true)
  expect(needsEmojiFallback("darwin", "26.3.1")).toBe(true)
  expect(needsEmojiFallback("darwin", "26.4.0")).toBe(false)
  expect(needsEmojiFallback("win32", "26.3.0")).toBe(false)
})

test("replaces complete and streaming emoji sequences with markdown-safe text", () => {
  expect(safeEmojiText("总结 📋 🇨🇳 1️⃣ 👨‍👩‍👧‍👦")).toBe(
    "总结 :emoji: :emoji: :emoji: :emoji:",
  )
  expect(safeEmojiText("流式 1️ #️")).toBe("流式 :emoji: :emoji:")
  expect(safeEmojiText("📋(说明)")).toBe(":emoji:(说明)")
})

test("sanitizes existing and newly inserted DOM content", async () => {
  const window = new Window()
  const document = window.document
  const existing = document.createElement("div")
  existing.title = "历史 📋"
  existing.textContent = "历史 ✅"
  document.body.append(existing)

  const cleanup = installEmojiFallback(document as unknown as Document)
  expect(existing.title).toBe("历史 :emoji:")
  expect(existing.textContent).toBe("历史 :emoji:")

  const image = document.createElement("img")
  image.alt = "截图 🎯"
  const input = document.createElement("input")
  input.placeholder = "输入 📌"
  document.body.append(image, input)
  await window.happyDOM.waitUntilComplete()

  expect(image.alt).toBe("截图 :emoji:")
  expect(input.placeholder).toBe("输入 :emoji:")
  input.value = "程序赋值 ✅"
  expect(input.value).toBe("程序赋值 :emoji:")
  cleanup()
  window.close()
})

test("sanitizes existing and newly attached shadow roots", async () => {
  const window = new Window()
  const document = window.document
  const existingHost = document.createElement("div")
  const existingShadow = existingHost.attachShadow({ mode: "open" })
  existingShadow.innerHTML = '<span title="标题 📋">内容 ✅</span>'
  document.body.append(existingHost)

  const cleanup = installEmojiFallback(document as unknown as Document)
  expect(existingShadow.textContent).toBe("内容 :emoji:")
  expect(existingShadow.firstElementChild?.getAttribute("title")).toBe("标题 :emoji:")

  const newHost = document.createElement("div")
  document.body.append(newHost)
  const newShadow = newHost.attachShadow({ mode: "open" })
  newShadow.innerHTML = '<span title="标题 🎯">内容 📌</span>'
  await window.happyDOM.waitUntilComplete()

  expect(newShadow.textContent).toBe("内容 :emoji:")
  expect(newShadow.firstElementChild?.getAttribute("title")).toBe("标题 :emoji:")
  cleanup()
  window.close()
})
