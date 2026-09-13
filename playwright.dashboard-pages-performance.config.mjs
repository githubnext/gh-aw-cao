import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/dashboard-pages-performance.spec.mjs"],
  outputDir: "test-results/dashboard-deployed/performance",
  timeout: 180_000,
  workers: 1,
  preserveOutput: "always",
  use: {
    ...devices["iPhone 15"],
    browserName: "webkit",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
