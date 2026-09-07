import { defineConfig, devices } from "@playwright/test";

const browserName = process.env.MOBILE_BROWSER;
const deviceName = process.env.MOBILE_DEVICE;

if (!browserName || !deviceName || !devices[deviceName]) {
  throw new Error("MOBILE_BROWSER and a valid MOBILE_DEVICE are required.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/dashboard-mobile-live.spec.mjs"],
  timeout: 120_000,
  workers: 1,
  use: {
    ...devices[deviceName],
    browserName,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
