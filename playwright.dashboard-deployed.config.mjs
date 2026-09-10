import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const chromiumExecutable = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/dashboard-deployed-refresh.spec.mjs"],
  outputDir: "test-results/dashboard-deployed/playwright",
  timeout: 300_000,
  workers: 1,
  preserveOutput: "always",
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
