import assert from "node:assert/strict";
import { test } from "node:test";
import { captureMobileDashboardScreenshot } from "../e2e/dashboard-screenshot.mjs";

test("mobile dashboard screenshot is limited to the viewport", async () => {
  const calls = [];
  const page = {
    screenshot: async (options) => calls.push(["screenshot", options]),
  };
  const testInfo = {
    attach: async (name, options) => calls.push(["attach", name, options]),
  };

  await captureMobileDashboardScreenshot(page, testInfo, "/tmp/mobile-dashboard.png");

  assert.deepEqual(calls, [
    ["screenshot", { path: "/tmp/mobile-dashboard.png", fullPage: false }],
    ["attach", "mobile-dashboard-screenshot", {
      path: "/tmp/mobile-dashboard.png",
      contentType: "image/png",
    }],
  ]);
});

test("mobile dashboard screenshot failure does not fail the test", async () => {
  let attached = false;
  const page = {
    screenshot: async () => {
      throw new Error("screenshot is too large");
    },
  };
  const testInfo = {
    attach: async () => {
      attached = true;
    },
  };

  await captureMobileDashboardScreenshot(page, testInfo, "/tmp/mobile-dashboard.png");

  assert.equal(attached, false);
});
