import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { maximumDashboardAssessmentTimeoutMs } from "../../e2e/dashboard-view-assessment.mjs";

const chromiumExecutable = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;

export default defineConfig({
  testDir: "../../e2e",
  testMatch: ["**/dashboard-views-live.spec.mjs"],
  outputDir: "../../../test-results/playwright-dashboard-views",
  timeout: maximumDashboardAssessmentTimeoutMs,
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