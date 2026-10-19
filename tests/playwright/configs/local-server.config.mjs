import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "../../e2e",
  testMatch: ["**/local-server-headers.spec.mjs"],
  outputDir: "../../../test-results",
  timeout: 30_000,
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  use: {
    headless: true,
    launchOptions: {
      args: ["--no-sandbox"],
      ...(executablePath ? { executablePath } : {}),
    },
  },
});