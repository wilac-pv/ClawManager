import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:4211",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-light",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, colorScheme: "light" },
    },
    {
      name: "mobile-light",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        colorScheme: "light",
      },
    },
    {
      name: "desktop-dark-os",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
    },
  ],
  webServer: [
    {
      command: "bun run e2e/fixtures/server.ts",
      url: "http://127.0.0.1:4210/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "bun run dev -- --host 127.0.0.1 --port 4211",
      url: "http://127.0.0.1:4211/skills",
      reuseExistingServer: false,
      timeout: 30_000,
      env: { VITE_SKILL_MARKET_API_URL: "http://127.0.0.1:4210" },
    },
  ],
})
