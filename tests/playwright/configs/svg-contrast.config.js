// @ts-check
"use strict";

const { defineConfig } = require("@playwright/test");

/**
 * Playwright configuration for the SVG color contrast check.
 *
 * Run with:
 *   npx playwright test --config=tests/playwright/configs/svg-contrast.config.js
 *
 * To scope the check to specific files:
 *   SVG_FILES="docs/assets/foo.svg" \
 *     npx playwright test --config=tests/playwright/configs/svg-contrast.config.js
 */
module.exports = defineConfig({
  testDir: "../../../scripts",
  testMatch: "**/check-svg-contrast.spec.js",
  outputDir: "../../../test-results",
  use: {
    headless: true,
    // Use a large viewport so that SVG bounding boxes reflect realistic sizes.
    viewport: { width: 1280, height: 800 },
  },
  reporter: "list",
  timeout: 30_000,
  // Run tests in sequence to keep resource usage low on CI runners.
  workers: 1,
  retries: 0,
});