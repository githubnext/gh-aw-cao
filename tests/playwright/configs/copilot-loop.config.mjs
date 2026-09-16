import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "../../e2e",
  testMatch: ["**/local-server-copilot-loop.spec.mjs"],
  outputDir: "../../../test-results",
  timeout: 30_000,
  workers: 1,
  use: {
    headless: true,
    launchOptions: {
      args: ["--no-sandbox"],
      ...(executablePath ? { executablePath } : {}),
    },
  },
});