import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const chromiumExecutable = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
const memoryMb = Number(process.env.DASHBOARD_STRESS_BROWSER_MEMORY_MB ?? 256);

export default defineConfig({
  testDir: "../../e2e",
  testMatch: ["**/dashboard-massive-scale.spec.mjs"],
  outputDir: "../../../test-results/playwright-dashboard-massive-scale",
  timeout: 1_800_000,
  workers: 1,
  preserveOutput: "always",
  use: {
    ...devices["Pixel 7"],
    browserName: "chromium",
    headless: true,
    launchOptions: {
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-precise-memory-info",
        `--js-flags=--max-old-space-size=${memoryMb}`,
      ],
      ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});