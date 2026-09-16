import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  testDir: "../../e2e",
  testMatch: ["**/local-server-headers.spec.mjs"],
  outputDir: "../../../test-results",
  timeout: 30_000,
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: {
      args: ["--no-sandbox"],
      ...(executablePath ? { executablePath } : {}),
    },
  },
  webServer: {
    command: "node dashboard/local-server.mjs",
    cwd: repositoryRoot,
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});