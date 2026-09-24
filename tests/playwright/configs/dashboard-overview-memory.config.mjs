import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { defineConfig } from "@playwright/test";

const chromiumExecutable = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
// The cap stays well above the asserted worker-heap budgets so a regression
// is reported as a budget failure rather than an opaque worker crash.
const memoryMb = Number(process.env.DASHBOARD_OVERVIEW_MEMORY_BROWSER_MEMORY_MB ?? 2048);

// Dedicated workers do not expose `performance.memory`, so the data worker's
// heap is read through the browser's CDP endpoint on a free loopback port.
process.env.DASHBOARD_MEMORY_CDP_PORT ??= String(await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
}));

export default defineConfig({
  testDir: "../../e2e",
  testMatch: ["**/dashboard-overview-memory.spec.mjs"],
  outputDir: "../../../test-results/playwright-dashboard-overview-memory",
  timeout: 1_800_000,
  workers: 1,
  preserveOutput: "always",
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: {
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--remote-debugging-port=${process.env.DASHBOARD_MEMORY_CDP_PORT}`,
        `--js-flags=--max-old-space-size=${memoryMb}`,
      ],
      ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
