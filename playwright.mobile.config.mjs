import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const browserName = process.env.MOBILE_BROWSER;
const deviceName = process.env.MOBILE_DEVICE;

if (!browserName || !deviceName || !devices[deviceName]) {
  throw new Error("MOBILE_BROWSER and a valid MOBILE_DEVICE are required.");
}

const chromiumExecutable = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/dashboard-mobile-live.spec.mjs"],
  timeout: 120_000,
  workers: 1,
  preserveOutput: "always",
  use: {
    ...devices[deviceName],
    browserName,
    headless: true,
    launchOptions: browserName === "chromium" ? {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    } : {},
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
