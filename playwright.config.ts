import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4311",
    headless: true,
    trace: "retain-on-failure",
    launchOptions: process.env.WORKFLOW_CHROMIUM_PATH
      ? { executablePath: process.env.WORKFLOW_CHROMIUM_PATH }
      : {},
  },
  webServer: {
    command: "bun tests/e2e/server.ts",
    url: "http://127.0.0.1:4311",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
