import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: ".",
  testMatch: "download-page.e2e.ts",
  use: {
    baseURL: "http://localhost:4173",
  },
  webServer: {
    command: "bun --port 4173 index.html",
    port: 4173,
    reuseExistingServer: true,
  },
})
