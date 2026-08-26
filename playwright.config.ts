import { defineConfig } from "@playwright/test"

const PORT = 4181

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.browser.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1600 },
  },
  webServer: {
    command: "node test/browser-server.ts",
    url: `http://127.0.0.1:${PORT}/up`,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
})
