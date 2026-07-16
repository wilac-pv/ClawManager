import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig(({ mode }) => {
  return {
    base: mode === "production" ? "/ai-coding/ruying-code/skill-market/" : "/",
    plugins: [solid()],
    server: { host: "127.0.0.1", port: 4211 },
    build: { target: "es2022", sourcemap: true },
  }
})
