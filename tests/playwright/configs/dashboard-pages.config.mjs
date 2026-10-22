import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "../../e2e",
  testMatch: "**/dashboard-pages.spec.mjs",
  outputDir: "../../../test-results/dashboard-pages",
  timeout: 180_000,
  workers: 1,
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      ...(executablePath ? { executablePath } : {}),
    },
    trace: "retain-on-failure",
  },
});
