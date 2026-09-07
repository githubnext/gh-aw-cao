import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/docs-narrow-viewport.spec.mjs"],
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4321/gh-aw-cao",
    headless: true,
    launchOptions: {
      args: ["--no-sandbox"],
      ...(executablePath ? { executablePath } : {}),
    },
  },
  webServer: {
    command: "npx astro preview --host 127.0.0.1 --port 4321",
    url: "http://127.0.0.1:4321/gh-aw-cao/",
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
