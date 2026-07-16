import { defineConfig, loadEnv } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "")
  if (mode === "production" && !environment.VITE_SKILL_MARKET_API_URL?.trim())
    throw new Error("VITE_SKILL_MARKET_API_URL is required for production builds")

  return {
    base: mode === "production" ? "/ai-coding/ruying-code/skill-market/" : "/",
    plugins: [solid()],
    server: { host: "127.0.0.1", port: 4211 },
    build: { target: "es2022", sourcemap: true },
  }
})
